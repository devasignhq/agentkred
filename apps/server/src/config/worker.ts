// Worker entry point: ingests the contract's events into the journal and delivers queued webhooks until stopped.

import { sleep } from "@agentkred/shared";
import { ChainIngestor } from "../journal/chainIngestor.js";
import { WebhookService } from "../services/webhookService.js";

const DISPATCH_INTERVAL_MS = 2_000;

/** Delivers due webhooks on a fixed interval until `signal` aborts. */
async function dispatchLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
        // Deliver what is due, logging failures and carrying on
        try {
            await WebhookService.dispatchDue();
        } catch (error) {
            console.error("webhook dispatch failed:", (error as Error).message);
        }
        await sleep(DISPATCH_INTERVAL_MS);
    }
}

// Stop both loops on SIGINT or SIGTERM
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => controller.abort());
}

// Run the ingestor and the dispatcher side by side
console.log("AgentKred worker started");
await Promise.all([ChainIngestor.loop(controller.signal), dispatchLoop(controller.signal)]);
