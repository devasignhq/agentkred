// The escrow coordinator: validates each party's signed call, submits it fee-bumped and returns the journal's view.

import { randomBytes } from "node:crypto";
import { xdr } from "@stellar/stellar-sdk";
import { ESCROW_ERRORS, EscrowClient, Manifest, Manifests, QuoteJson, SimulationError, Submitted, Submitter } from "@agentkred/shared";
import { prisma } from "../config/db.js";
import { ApiError } from "../config/errors.js";
import { EscrowFold, EscrowRecord } from "../journal/escrowFold.js";
import { ChainIngestor } from "../journal/chainIngestor.js";
import { CallValidator } from "../utils/callValidator.js";
import { LockValidator } from "../utils/lockValidator.js";
import { stellar } from "../config/stellar.js";

/** The journal's view of an escrow, with the quote's schedule, the manifest and any dispute AgentKred holds. */
export interface EscrowDetails extends EscrowRecord {
    schedule: { completeness: number; payout: string }[] | null;
    manifest: { artifactSha256: string; evidenceUrl: string | null } | null;
    dispute: { completeness: number; evidenceUrl: string | null; note: string | null } | null;
}

/** Contract errors that mean the escrow is in the wrong state or past or before a deadline. */
const CONFLICT_ERRORS = new Set([5, 6, 7, 8, 9, 15, 16]);

export class EscrowService {
    /**
     * Validates and submits a buyer's lock of a seller-signed quote.
     * @param quoteJson - The seller-signed quote
     * @param auth - The buyer's signed `lock` auth entry as base64 XDR
     * @param buyerWebhookUrl - Where to send the buyer this escrow's webhooks, if anywhere
     * @returns The new escrow, its lock transaction, and the buyer's webhook secret when a URL was given
     */
    static async lock(
        quoteJson: QuoteJson,
        auth: string,
        buyerWebhookUrl?: string,
    ): Promise<{ escrow: EscrowDetails; txHash: string; buyerWebhookSecret?: string }> {
        // Gather the listing, the ledger and whether the quote was already locked
        const listing = await prisma.seller.findUnique({ where: { payTo: quoteJson.terms.seller } });
        const currentLedger = await stellar.chain.ledgerSequence();
        const quoteUsed = (await prisma.escrow.count({ where: { quoteHash: quoteJson.quoteHash.toLowerCase() } })) > 0;

        // Run every pre-lock check
        const { quote, entry, buyer } = LockValidator.validate(quoteJson, auth, {
            listing,
            currentLedger,
            quoteUsed,
            escrow: stellar.escrow,
            usdcContractId: stellar.usdcContractId,
        });

        // Store the quote, leaving an existing row as it is
        const quoteHash = quote.quoteHash.toString("hex");
        const stored = { quoteHash, seller: quote.terms.seller, terms: quoteJson.terms, signature: quote.signature.toString("hex") };
        await prisma.quote.upsert({ where: { quoteHash }, create: stored, update: {} });

        // Store the buyer's webhook under this buyer with a fresh secret
        const buyerWebhookSecret = buyerWebhookUrl ? randomBytes(32).toString("hex") : undefined;
        if (buyerWebhookUrl && buyerWebhookSecret) {
            await prisma.buyerWebhook.upsert({
                where: { quoteHash_buyer: { quoteHash, buyer } },
                create: { quoteHash, buyer, url: buyerWebhookUrl, secret: buyerWebhookSecret },
                update: { url: buyerWebhookUrl, secret: buyerWebhookSecret },
            });
        }

        // Submit the lock and read the new escrow from the journal
        const submitted = await this.submit("lock", null, stellar.escrow.lockCall(buyer, quote), entry);
        const escrowId = EscrowClient.escrowId(submitted);
        const escrow = await this.get(escrowId);

        return { escrow, txHash: submitted.hash, buyerWebhookSecret };
    }

    /** Submits the seller's acceptance of an escrow. */
    static async accept(escrowId: bigint, auth: string): Promise<EscrowDetails> {
        // Check the seller signed exactly this accept, then submit it
        const escrow = await this.load(escrowId);
        const operation = stellar.escrow.acceptCall(escrowId);
        const entry = CallValidator.validate(auth, operation, escrow.seller, await stellar.chain.ledgerSequence());
        await this.submit("accept", escrowId, operation, entry);

        return this.get(escrowId);
    }

    /**
     * Stores the seller's manifest and submits `deliver` with its hash.
     * @param artifactSha256 - The delivered artifact's sha256, as lowercase hex
     * @param evidenceUrl - Where the delivery's evidence can be read, if anywhere
     * @param auth - The seller's signed `deliver` auth entry carrying the manifest hash
     */
    static async deliver(escrowId: bigint, artifactSha256: string, evidenceUrl: string | null, auth: string): Promise<EscrowDetails> {
        // Hash the manifest and check the seller signed a deliver of exactly that hash
        const escrow = await this.load(escrowId);
        const manifest: Manifest = { escrowId: escrowId.toString(), artifactSha256, evidenceUrl };
        const hash = Manifests.hash(manifest);
        const operation = stellar.escrow.deliverCall(escrowId, hash);
        const entry = CallValidator.validate(auth, operation, escrow.seller, await stellar.chain.ledgerSequence());

        // Store the manifest, then submit the delivery
        const row = { hash: hash.toString("hex"), escrowId, artifactSha256, evidenceUrl };
        await prisma.manifest.upsert({ where: { hash: row.hash }, create: row, update: {} });
        await this.submit("deliver", escrowId, operation, entry);

        return this.get(escrowId);
    }

    /** Submits the buyer's acknowledgement of a delivery. */
    static async acknowledge(escrowId: bigint, auth: string): Promise<EscrowDetails> {
        // Check the buyer signed exactly this acknowledgement, then submit it
        const escrow = await this.load(escrowId);
        const operation = stellar.escrow.acknowledgeCall(escrowId);
        const entry = CallValidator.validate(auth, operation, escrow.buyer, await stellar.chain.ledgerSequence());
        await this.submit("acknowledge", escrowId, operation, entry);

        return this.get(escrowId);
    }

    /**
     * Submits the buyer's dispute at a completeness percentage and stores its evidence.
     * @param completeness - The schedule step the buyer says the work reached, below 100
     * @param evidenceUrl - Where the buyer's evidence can be read, if anywhere
     * @param note - The buyer's explanation, if any
     * @param auth - The buyer's signed `dispute` auth entry at that completeness
     */
    static async dispute(escrowId: bigint, completeness: number, evidenceUrl: string | null, note: string | null, auth: string): Promise<EscrowDetails> {
        // Check the buyer signed exactly this dispute, then submit it
        const escrow = await this.load(escrowId);
        const operation = stellar.escrow.disputeCall(escrowId, completeness);
        const entry = CallValidator.validate(auth, operation, escrow.buyer, await stellar.chain.ledgerSequence());
        await this.submit("dispute", escrowId, operation, entry);

        // Store the evidence behind the accepted dispute
        await prisma.dispute.create({ data: { escrowId, completeness, evidenceUrl, note } });

        return this.get(escrowId);
    }

    /** Returns the journal's view of an escrow, or throws a 404. */
    static async get(escrowId: bigint): Promise<EscrowDetails> {
        // Fold the escrow's lock row and transitions into its current view
        const escrow = await this.load(escrowId);
        const record = EscrowFold.fold(escrow, escrow.transitions.map((row) => ({ ...row, data: row.data as Record<string, string | number> })));

        // Attach the quote's schedule, the manifest and the latest dispute AgentKred holds
        const quote = await prisma.quote.findUnique({ where: { quoteHash: escrow.quoteHash } });
        const manifest = record.manifestHash ? await prisma.manifest.findUnique({ where: { hash: record.manifestHash } }) : null;
        const dispute = await prisma.dispute.findFirst({ where: { escrowId }, orderBy: { id: "desc" } });

        return {
            ...record,
            schedule: quote ? (quote.terms as QuoteJson["terms"]).schedule : null,
            manifest: manifest ? { artifactSha256: manifest.artifactSha256, evidenceUrl: manifest.evidenceUrl } : null,
            dispute: dispute ? { completeness: dispute.completeness, evidenceUrl: dispute.evidenceUrl, note: dispute.note } : null,
        };
    }

    /** Loads an escrow and its transitions, ingesting once more before giving up with a 404. */
    private static async load(escrowId: bigint) {
        // Read the journal, catching up once when the escrow is not there yet
        const query = () => prisma.escrow.findUnique({ where: { id: escrowId }, include: { transitions: true } });
        const escrow = (await query()) ?? ((await ChainIngestor.runOnce()) > 0 ? await query() : null);
        if (!escrow) {
            throw new ApiError(404, "escrow_not_found", `Escrow ${escrowId} is not in the journal`);
        }

        return escrow;
    }

    /**
     * Submits an authorized call through the fee-bump, journals the attempt and waits for the journal to catch up.
     * @param kind - The contract method, recorded with the submission
     * @param escrowId - The escrow the call acts on, unknown before a lock lands
     * @param operation - The unauthorized call
     * @param entry - The party's signed auth entry for it
     */
    private static async submit(kind: string, escrowId: bigint | null, operation: xdr.Operation, entry: xdr.SorobanAuthorizationEntry): Promise<Submitted> {
        // Record the attempt before anything reaches the network
        const row = await prisma.chainTransaction.create({ data: { kind, escrowId } });
        const { channel, fees } = stellar.sponsor();

        // Submit, recording a failure and translating contract errors
        let submitted: Submitted;
        try {
            submitted = await stellar.submitter.submitAuthorized(Submitter.withAuth(operation, [entry]), channel, fees);
        } catch (error) {
            await prisma.chainTransaction.update({ where: { id: row.id }, data: { status: "Failed", error: (error as Error).message.slice(0, 2_000) } });
            throw this.translate(error);
        }

        // Record the success and wait for the journal to read its ledger
        const resolvedId = escrowId ?? (kind === "lock" ? EscrowClient.escrowId(submitted) : null);
        await prisma.chainTransaction.update({
            where: { id: row.id },
            data: { status: "Succeeded", hash: submitted.hash, ledger: submitted.ledger, escrowId: resolvedId },
        });
        await ChainIngestor.waitForLedger(submitted.ledger);

        return submitted;
    }

    /** Converts a failed simulation into an API error naming the contract error, passing other errors through. */
    private static translate(error: unknown): unknown {
        // Leave anything that is not a simulation failure as it is
        if (!(error instanceof SimulationError)) {
            return error;
        }

        // Name the contract error, or report the host's rejection
        const code = error.contractErrorCode();
        if (code === null) {
            return new ApiError(422, "simulation_failed", error.message.split("\n")[0].slice(0, 500));
        }
        const name = ESCROW_ERRORS[code] ?? `ContractError${code}`;
        const status = code === 1 ? 404 : CONFLICT_ERRORS.has(code) ? 409 : 422;

        return new ApiError(status, snakeCase(name), `The escrow contract rejected the call with ${name} (#${code})`);
    }
}

/** Converts a PascalCase name to snake_case. */
function snakeCase(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
