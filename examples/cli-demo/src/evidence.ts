// Collects contract and transaction details from a demo run and writes them as a Markdown evidence file.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Config } from "./config.js";
import { Deployment } from "./state.js";

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
    private readonly startedAt = new Date();

    /** Starts an evidence log for the given deployment. */
    constructor(private readonly deployment: Deployment) {}

    /** Records one confirmed transaction. */
    addStep(step: EvidenceStep): void {
        this.steps.push(step);
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

        // Add the free-form notes
        lines.push("", "## Notes", "", ...this.notes.map((note) => `- ${note}`), "");

        // Write the file named after the run's start time
        mkdirSync(Config.evidenceDir, { recursive: true });
        const path = resolve(Config.evidenceDir, `run-${this.startedAt.toISOString().replace(/[:.]/g, "-")}.md`);
        writeFileSync(path, lines.join("\n"));

        return path;
    }
}
