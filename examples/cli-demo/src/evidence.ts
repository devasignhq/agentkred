// Collects contract and transaction details from a demo run and writes them as a Markdown evidence file.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Config } from "./config.js";
import { Deployment } from "./state.js";
import { WorkRecord } from "./workRecord.js";

export interface EvidenceStep {
    run: string;
    step: string;
    caller: string;
    feePaidBy: string;
    hash: string;
}

export class Evidence {
    private readonly steps: EvidenceStep[] = [];
    private readonly notes: string[] = [];
    private readonly records: WorkRecord[] = [];
    private readonly startedAt = new Date();

    /** Starts an evidence log for the given deployment. */
    constructor(private readonly deployment: Deployment) {}

    /** Records one confirmed transaction. */
    addStep(step: EvidenceStep): void {
        this.steps.push(step);
    }

    /** Records the work record of a closed escrow. */
    addRecord(record: WorkRecord): void {
        this.records.push(record);
    }

    /** Records a free-form line, such as a balance snapshot. */
    addNote(note: string): void {
        this.notes.push(note);
    }

    /** Writes the evidence file and returns its path. */
    write(): string {
        // Build the deployment section
        const explorer = Config.explorerUrl;
        const lines = [
            "# AgentKred testnet escrow run",
            "",
            `Run started ${this.startedAt.toISOString()} on Stellar testnet.`,
            "",
            "## Contract",
            "",
            `- Contract ID: \`${this.deployment.contractId}\` ([explorer](${explorer}/contract/${this.deployment.contractId}))`,
            `- WASM hash: \`${this.deployment.wasmHash}\``,
            `- Upload tx: [\`${this.deployment.uploadTx}\`](${explorer}/tx/${this.deployment.uploadTx})`,
            `- Deploy tx: [\`${this.deployment.deployTx}\`](${explorer}/tx/${this.deployment.deployTx})`,
            "",
            "## Transactions",
            "",
            "| Run | Step | Called by | Fee paid by | Transaction |",
            "| --- | --- | --- | --- | --- |",
        ];

        // Add one table row per confirmed transaction
        for (const step of this.steps) {
            lines.push(`| ${step.run} | ${step.step} | ${step.caller} | ${step.feePaidBy} | [\`${step.hash}\`](${explorer}/tx/${step.hash}) |`);
        }

        // Add one section per work record
        lines.push("", "## Work records");
        for (const record of this.records) {
            lines.push(...this.recordLines(record));
        }

        // Add the free-form notes
        lines.push("", "## Notes", "", ...this.notes.map((note) => `- ${note}`), "");

        // Write the file named after the run's start time
        mkdirSync(Config.evidenceDir, { recursive: true });
        const path = resolve(Config.evidenceDir, `run-${this.startedAt.toISOString().replace(/[:.]/g, "-")}.md`);
        writeFileSync(path, lines.join("\n"));

        return path;
    }

    /** Formats one work record as a Markdown section. */
    private recordLines(record: WorkRecord): string[] {
        // Build the closing transaction link and the formatted clock values
        const closeLink = `[\`${record.closeTx}\`](${Config.explorerUrl}/tx/${record.closeTx})`;
        const manifest = record.manifestHash ? `\`${record.manifestHash}\`` : "none (never delivered)";
        const onTime = record.deliveredOnTime == null ? "" : record.deliveredOnTime ? " (on time)" : " (late)";
        const delivered = `${record.deliveredAt ?? "-"}${onTime}`;

        return [
            "",
            `### Escrow ${record.escrowId}: ${record.outcome}`,
            "",
            `- Outcome: **${record.outcome}** (${record.meaning})`,
            `- Buyer: \`${record.buyer}\``,
            `- Seller: \`${record.seller}\``,
            `- Asset: ${record.asset}`,
            `- Cap / payout to seller: ${record.cap} / ${record.payout}`,
            `- Payment reference: escrow ${record.escrowId} + ${closeLink}`,
            `- Quote hash: \`${record.quoteHash}\``,
            `- Manifest hash: ${manifest}`,
            `- Locked at ${record.lockedAt}, deliver-by ${record.deliverBy}, delivered at ${delivered}`,
            `- Acknowledged at ${record.acknowledgedAt ?? "-"}, dispute-by ${record.disputeBy ?? "-"}, closed at ${record.closedAt ?? "-"}`,
            "- Times are ledger time in unix seconds",
        ];
    }
}
