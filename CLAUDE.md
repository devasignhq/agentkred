# AgentKred

AgentKred lets agents pay for **long-running jobs on Stellar using x402**. A buyer locks a quoted amount in a Soroban escrow contract with one signature, the seller delivers directly to the buyer, and the contract releases or refunds the funds on deadlines fixed at lock time. Every settled or refunded job leaves a public, signed work record tied to the seller, and buyers can search sellers by those records before they pay.

## Repository layout

| Path | What it is |
| --- | --- |
| `contracts/escrow/` | Rust Soroban escrow contract. One escrow per job: holds the buyer's USDC, enforces the accept, deliver and dispute deadlines and the payout gate (`floor ≤ payout ≤ cap`). |
| `apps/server/` | The AgentKred service, backed by Postgres. Escrow API and state journal, clock worker, signed webhooks, fee-bumping transaction submitter, catalog and work-record service. |
| `apps/mcp/` | MCP server exposing the catalog to agents. |
| `packages/seller-middleware/` | TypeScript seller middleware: quotes, escrow checks, accept and delivery. |
| `packages/buyer-sdk/` | TypeScript buyer SDK: quote and record checks, the lock, artifact verification, acknowledge or dispute. |
| `packages/shared/` | Types and utilities shared by the server, SDK and middleware. |
| `packages/conformance/` | Conformance suite that sellers and buyers run against the protocol. |
| `examples/` | `cli-demo` and `reference-sellers`. |
| `docs/` | User-facing protocol and integration documentation. |
| `infra/` | Deployment and infrastructure configuration. |

## Core capabilities

- **Escrowed x402 jobs** — the seller's `POST /jobs` answers with a 402 and a signed quote (cap, floor, payout schedule, deadlines). The buyer signs one Soroban authorization, AgentKred submits the lock, and the buyer retries with the escrow id.
- **Deadline-enforced settlement** — the seller accepts, delivers and posts a manifest whose hash is recorded on chain. The buyer acknowledges or disputes with a completeness percentage; silence until the window closes counts as acknowledging. A missed deadline refunds the buyer.
- **Non-custodial by design** — `settle` and `refund` are permissionless, so any escrow can close with AgentKred offline. The buyer SDK and seller middleware call them too, so the clock worker is a convenience, not a dependency. AgentKred never holds a key that can move user funds; it only fee-bumps, so buyers and sellers need nothing but USDC.
- **Work records & catalog** — records are built from the contract's settle and refund events, signed by AgentKred, served at public URLs and mirrored to the Stellar 8004 reputation registry. Short x402 jobs get records through an adapter that reads the settlement transaction. The catalog ranks long-running sellers by these records over REST and MCP.

## Working rules

- **Keep both sides of every interface in sync.** A change to the contract, the server API or the protocol must land with the matching change in the buyer SDK, seller middleware and conformance suite in the same pass — never leave a client calling something that doesn't exist yet.
- **Keep the docs in sync.** Any change to how the product behaves — the job lifecycle, deadlines, payout rules, quote or manifest formats, work records, the catalog — must be reflected in `docs/` (and the README where it describes the same thing) in the same pass. Skip it only for internal refactors no user can observe.
- **Never add custody.** No server code may hold or request a key that can move user funds. Anything that settles or refunds must remain callable without AgentKred.
- **Services are classes.** Backend services are a single class with methods (static by default; instance + exported singleton only when instance state is needed).
- **Every feature ships with its tests.** Adding or changing behaviour means writing the matching tests in the same pass, and updating every existing test whose behaviour you moved. Run the affected package's tests (and `cargo test` for contract changes) and report the result; a feature whose tests were left for later is not finished.
- **Schema changes** go through versioned migrations — never hand-edit a production database.
- **Indentation is 4 spaces**, TypeScript throughout.
- **Do not congest code.** I want my code properly spaced for readability.
- **Comments follow the guidelines below — no exceptions, no judgement calls.** This is the single most-violated rule in this repo. It applies to *every* file you create or edit, in *every* language, on *every* task — including quick fixes, and including code you are only passing through. Before you report a task as done, run the self-audit at the end of this file against your own diff. A change carrying a comment that breaks these rules is **not finished**.

---

## Codebase Commenting Guidelines

This codebase follows a strict, standardized **descriptive** commenting pattern across all files to ensure maintainability, clarity, and readability. By **descriptive**, I mean logical step should have a comment that explains the implementation for human readers. **Do not over-explain** — if the code is self-explanatory, don't add a comment. This is a **must-follow rule**, not a preference.

> **Reference:** the examples below. When in doubt, match them.

### The three hard limits

These are mechanical. They are not style preferences and they are not negotiable against "but this bit is subtle":

| Comment kind | Hard limit |
| --- | --- |
| Module header (top of file) | **2 lines max**, ever |
| Function/method JSDoc | **1 line** by default; expand ONLY for `@param`/`@returns`, plus at most **one** short clause of *why* |
| Internal step comment (`// …`) | **Exactly 1 line.** Never 2. No *why*, no "because", no trailing rationale clause |

**These limits apply to every language in the repo** — TypeScript, Rust (`//` and `///`), SQL, config. Rust doc comments (`///`) follow the JSDoc rule; Rust step comments follow the step-comment rule.

If a comment does not fit its limit, the comment is wrong — **cut it down**. Do not widen the limit, do not split it across two lines, and do not move the overflow into the line above.

---

### Core Rules

#### 1. Module Header (Top-of-File Overview)

- Keep top-of-file comments concise (1–2 lines max).
- State the module's core responsibility directly.
- Avoid wordy, multi-paragraph architectural essays at the top of files.

**Example:**
```typescript
// Account deletion service: tears down sole-owned installations end-to-end and detaches users from shared installations.
```

---

#### 2. Method & Function JSDocs

- Every exported or internal method/function MUST have a JSDoc (`/** ... */`).
- Explain *what* the function does in direct, easy-to-understand language.
- Default to a **single line**. Expand to a multi-line block with `@param` / `@returns` when the parameters or return value genuinely need explaining — as in the expanded example below.
- Where a non-obvious constraint drives the design, add one short line of *why* — never a paragraph.
- **The JSDoc is the ONLY place a *why* may appear**, and it gets at most one short clause. If you feel the urge to justify something inside the function body, it belongs here instead — or nowhere.

**Single-line (default):**
```typescript
/** Permanently deletes a user account and tears down or detaches all associated installations. */
static async deleteAccount(userId: string): Promise<void> { ... }
```

**Expanded (when params/return need it):**
```typescript
/**
 * Re-queue indexing for every repository of an installation whose last run failed.
 * A failed index leaves that repository's reviews without context, so this is the
 * recovery sweep.
 * @param installationId - The ID of the installation
 * @returns The number of indexing jobs queued
 */
async retryFailedIndexing(installationId: string): Promise<number> { ... }
```

---

#### 3. Internal Descriptive Step Comments
This is the rule that defines the codebase's style.

- Place a descriptive comment (`// ...`) above **every logical block or step** inside a function, method, or constructor body.
- **Reading the comments alone must completely describe the step-by-step logic of the function.** That is the test — if you strip the code and the comments no longer narrate what happens, the comments are wrong.
- Keep each comment **short and imperative** ("Build the prompt…", "Parse the response…").
- **STRICT RULE — ONE LINE:** A step comment occupies **exactly one line**. A two-line step comment is always a bug in the comment, never a necessity of the code. Delete words until it fits, or move the *why* up into the function's JSDoc.
- **STRICT RULE — WHAT, NOT WHY:** A step comment says what the next block *does*. It never explains *why*. These words almost always signal a smuggled-in rationale — if one appears, cut the clause: "because", "since", "so that", "which means", "the reason", "otherwise it would". An em-dash followed by justification is the same violation wearing a disguise.
- **STRICT RULE — NO NUMBERING:** Do NOT number comments (e.g. do NOT use `// 1.`, `// 2.`, `// 1:`). Keep comments plain and un-numbered.
- **STRICT RULE — NO BANNERS:** No section dividers, box-drawing characters, `── Stage N ──` rules, or ASCII art inside function bodies.

**Example (GOOD):**
```typescript
/** Synthesizes acceptance criteria from PR review context. */
async synthesizeCriteria(context: ReviewContext, maintainerPrompt?: string): Promise<SynthesizedCriteria> {
    try {
        // Build prompt and system instructions for criteria synthesis
        const { prompt, systemInstruction } = this.buildSynthesizeCriteriaPrompt(context, maintainerPrompt);

        // Execute API call with structured output schema
        const aiResponse = await this.callGeminiAPI(
            prompt,
            systemInstruction,
            this.getSynthesizeCriteriaResponseSchema()
        );

        // Parse JSON response into SynthesizedCriteria structure
        const parsed = this.parseAIResponse<SynthesizedCriteria>(aiResponse);
        if (!parsed) {
            throw new GeminiServiceError("Failed to parse criteria synthesis response into JSON", { response: aiResponse });
        }

        return {
            endGoal: parsed.endGoal ?? null,
            criteria: Array.isArray(parsed.criteria) ? parsed.criteria : []
        };
    } catch (error) {
        if (error instanceof GeminiServiceError) throw error;
        throw new GeminiServiceError("Failed to synthesize criteria", error);
    }
}
```

**Constructors get the same treatment:**
```typescript
constructor() {
    super();
    // Verify GCP project ID configuration
    if (!Env.gcpProjectId()) {
        throw new GeminiServiceError("Missing GCP credentials (GCP_PROJECT_ID) in environment variables");
    }

    // Set service configuration parameters
    this.config = { ... };

    // Initialize GoogleGenAI client with Vertex AI parameters
    this.ai = new GoogleGenAI({ ... });
}
```

**Example (BAD — DO NOT DO THIS):**
```typescript
// BAD: Numbered comments inside methods
// 1. Build prompt and system instructions for criteria synthesis
// 2. Execute API call with structured output schema
// 3. Parse JSON response into SynthesizedCriteria structure

// BAD: Multi-sentence rationale essay where one imperative line belongs
// We need to parse the response here because the model sometimes wraps the JSON
// in a markdown fence, and if we don't strip it the downstream consumer will
// throw, which would then surface as a 500 to the caller...
```

**The two-line step comment — the most common violation. Every pair below is a real rewrite:**
```typescript
// BAD — two lines, and the second smuggles in the why
// Simulate transaction and attach required Soroban footprint/resources. Simulation is where the
// contract's own guards fire, so a rejection here is translated rather than escaping as a 500.
// GOOD
// Simulate the transaction and attach its Soroban footprint

// BAD — the "so …" clause is rationale, and it forced a second line
// Past its retention window the RPC reports a long-succeeded transaction as NOT_FOUND,
// so corroborate against contract state before writing off real money as failed
// GOOD
// Corroborate against contract state before failing the transaction

// BAD — two sentences describing one step
// Only a CONFIRMED row is already accounted for. A PENDING one is the stuck case this recovers:
// the escrow is on-chain but its receipt was never resolved, so fall through and settle it.
// GOOD
// Short-circuit only on a CONFIRMED row; a PENDING one falls through to be settled
```

**Rust follows the same rules — a doc comment is not a licence to write an essay:**
```rust
// BAD — a multi-paragraph file/item header
/// Comprehensive error types for the task escrow contract.
///
/// Every variant's numeric value is part of the deployed contract's ABI and is echoed to
/// clients as `Error(Contract, #N)` — never renumber one. The server maps these codes to
/// buyer- and seller-facing copy in `apps/server`; keep that table in step with this enum.

// GOOD
/// Error codes for the task escrow contract. Values are ABI — never renumber one.
```

---

### Summary Checklist for Contributors & AI Agents

1. **Module Header**: Short 1–2 line summary of file purpose.
2. **Function JSDoc**: `/** ... */` describing the method's purpose; single line by default, `@param`/`@returns` when they add value. The only home for a *why*.
3. **Internal Logic**: Short, imperative, **one-line** `// ...` comment before every logical block — including in constructors.
4. **Narrative Test**: The comments read top-to-bottom must describe the whole function on their own.
5. **No Numbers**: Never use `1.`, `2.`, `Step 1:`, etc. in internal comments.
6. **No Why, No Banners**: No rationale in step comments, no section dividers inside function bodies.

---

### Mandatory self-audit before reporting a task done

Do not skip this because the change was small or because you were confident while writing it. **Every past violation was written by an agent that believed it was following these rules.** Re-read the diff with fresh eyes and check each item:

- [ ] Every file I created has a module header of **≤ 2 lines**.
- [ ] Every function I added or edited has a JSDoc, single-line unless `@param`/`@returns` earn the expansion.
- [ ] **No step comment in my diff occupies two lines.** Check this literally — read each `//` and look at the line beneath it.
- [ ] No step comment contains "because", "since", "so that", "otherwise", "rather than", or an em-dash followed by justification.
- [ ] No numbered comments, no banner/divider comments.
- [ ] Stripping the code from my diff leaves comments that still narrate what happens.

This catches the recurring failure mechanically:

```bash
# Any hit inside a function body is a violation to fix before reporting done.
# Flags consecutive // lines (two-line step comments):
grep -n -A1 '^\s*//[^/]' <changed-file> | grep -B1 '^\s*[0-9]*-\s*//[^/]'
```
