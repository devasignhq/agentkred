// Reads the escrow contract's events from RPC into the append-only journal and projects each one.

import { EscrowEvent, EscrowEvents, sleep } from "@agentkred/shared";
import { rpc, xdr } from "@stellar/stellar-sdk";
import { prisma, Tx } from "../config/db.js";
import { Env } from "../config/env.js";
import { stellar } from "../config/stellar.js";
import { ChainEvent } from "../generated/prisma/client.js";
import { EscrowProjector, EventMeta } from "./escrowProjector.js";

const CURSOR_NAME = "escrow";
const PAGE_LIMIT = 200;
/** Postgres advisory lock held while ingesting or rebuilding, so only one runs at a time. */
export const INGEST_LOCK_KEY = 4_250_801;
const RETENTION_MARGIN_LEDGERS = 10;

export class ChainIngestor {
    /**
     * Reads every new contract event once, under a database lock so only one ingestor runs at a time.
     * @returns The number of events read, or 0 when another ingestor holds the lock
     */
    static async runOnce(): Promise<number> {
        return prisma.$transaction(
            async (tx) => {
                // Take the ingest lock, leaving the work to whoever already holds it
                const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${INGEST_LOCK_KEY}) AS locked`;
                if (!locked) {
                    return 0;
                }

                // Resume from the saved cursor, or start at the configured or oldest available ledger
                const saved = await tx.ingestCursor.findUnique({ where: { name: CURSOR_NAME } });
                let position: { cursor: string } | { startLedger: number } = saved?.cursor
                    ? { cursor: saved.cursor }
                    : { startLedger: await this.startLedger() };

                let total = 0;
                for (;;) {
                    // Fetch the next page of this contract's events
                    const page = await stellar.chain.server.getEvents({
                        ...position,
                        filters: [{ type: "contract", contractIds: [stellar.contractId] }],
                        limit: PAGE_LIMIT,
                    } as rpc.Api.GetEventsRequest);

                    // Store and project each event
                    for (const event of page.events) {
                        await this.store(tx, event);
                    }
                    total += page.events.length;

                    // Save the last ledger read in full
                    const full = page.events.length === PAGE_LIMIT;
                    const ledger = full ? page.events[page.events.length - 1].ledger - 1 : Math.min(this.cursorLedger(page.cursor), page.latestLedger);
                    await tx.ingestCursor.upsert({
                        where: { name: CURSOR_NAME },
                        create: { name: CURSOR_NAME, cursor: page.cursor, ledger },
                        update: { cursor: page.cursor, ledger },
                    });

                    // Stop once a partial page has scanned up to the latest ledger
                    if (!full && ledger >= page.latestLedger) {
                        return total;
                    }
                    position = { cursor: page.cursor };
                }
            },
            { maxWait: 10_000, timeout: 120_000 },
        );
    }

    /** Ingests until the journal has read through `ledger`, throwing after `timeoutMs`. */
    static async waitForLedger(ledger: number, timeoutMs = 30_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            // Ingest and check how far the cursor has reached
            await this.runOnce();
            const cursor = await prisma.ingestCursor.findUnique({ where: { name: CURSOR_NAME } });
            if (cursor && cursor.ledger >= ledger) {
                return;
            }

            // Give up past the deadline, or wait for the next ledger
            if (Date.now() > deadline) {
                throw new Error(`The journal did not reach ledger ${ledger} within ${timeoutMs}ms`);
            }
            await sleep(1_000);
        }
    }

    /** Ingests forever at the network's poll interval until `signal` aborts. */
    static async loop(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            // Ingest, logging failures and carrying on
            try {
                await this.runOnce();
            } catch (error) {
                console.error("ingest failed:", (error as Error).message);
            }
            await sleep(stellar.chain.config.pollIntervalMs);
        }
    }

    /** Decodes a stored event row back into its typed event and position. */
    static decodeStored(row: ChainEvent): { event: EscrowEvent | null; meta: EventMeta } {
        // Decode the topics and value from their base64 XDR
        const topics = row.topics.map((topic) => xdr.ScVal.fromXdr(topic, "base64"));
        const event = EscrowEvents.decode(topics, xdr.ScVal.fromXdr(row.value, "base64"));

        return { event, meta: { id: row.id, ledger: row.ledger, closedAt: Math.floor(row.ledgerClosedAt.getTime() / 1000), txHash: row.txHash } };
    }

    /** Appends one RPC event to the journal and projects it the first time it is seen. */
    private static async store(tx: Tx, event: rpc.Api.EventResponse): Promise<void> {
        // Skip events from failed contract calls
        if (event.inSuccessfulContractCall === false) {
            return;
        }

        // Append the raw event, noting whether it is new
        const decoded = EscrowEvents.decode(event.topic, event.value);
        const inserted = await tx.chainEvent.createMany({
            data: [
                {
                    id: event.id,
                    ledger: event.ledger,
                    ledgerClosedAt: new Date(event.ledgerClosedAt),
                    txHash: event.txHash,
                    contractId: event.contractId?.contractId() ?? stellar.contractId,
                    name: decoded?.name ?? "unknown",
                    topics: event.topic.map((topic) => topic.toXdr("base64")),
                    value: event.value.toXdr("base64"),
                },
            ],
            skipDuplicates: true,
        });

        // Project a new escrow event
        if (inserted.count > 0 && decoded) {
            const meta = { id: event.id, ledger: event.ledger, closedAt: Math.floor(Date.parse(event.ledgerClosedAt) / 1000), txHash: event.txHash };
            await EscrowProjector.project(tx, decoded, meta, true);
        }
    }

    /** Returns the configured start ledger, raised to just inside the RPC's retention window. */
    private static async startLedger(): Promise<number> {
        // Read the RPC's retention window and clamp the configured start into it
        const health = await stellar.chain.server.getHealth();
        return Math.max(Env.ingestStartLedger() ?? 0, health.oldestLedger + RETENTION_MARGIN_LEDGERS);
    }

    /** Returns the ledger an RPC paging cursor has scanned through, read from its TOID. */
    static cursorLedger(cursor: string): number {
        return Number(BigInt(cursor.split("-")[0]) >> 32n);
    }
}
