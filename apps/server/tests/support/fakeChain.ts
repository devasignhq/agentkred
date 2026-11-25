// A fake RPC and submitter for the database tests: contract events are queued in memory and paged like RPC pages them.

import { Contract, Keypair, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { EscrowClient, Submitted, Submitter, TESTNET } from "@agentkred/shared";
import { prisma } from "../../src/config/db.js";
import { stellar } from "../../src/config/stellar.js";
import { ESCROW_ID, USDC_ID } from "./fixtures.js";

/** Returns an RPC paging cursor positioned at the end of `ledger`. */
function cursorAt(ledger: number): string {
    return `${((BigInt(ledger) + 1n) << 32n) - 1n}-4294967295`;
}

export class FakeChain {
    readonly events: rpc.Api.EventResponse[] = [];
    latestLedger = 1_000;
    submitted: xdr.Operation[] = [];
    nextSubmit: (operation: xdr.Operation) => Submitted = () => {
        throw new Error("No submission expected");
    };

    /** Installs this fake as the server's chain reader, submitter and escrow client. */
    install(): void {
        // Answer RPC reads from memory
        const server = {
            getHealth: async () => ({ oldestLedger: 900, latestLedger: this.latestLedger }),
            getLatestLedger: async () => ({ sequence: this.latestLedger, closeTime: "0" }),
            getEvents: async (request: { startLedger?: number; cursor?: string; limit: number }) => this.page(request),
        };
        const chain = { server, config: TESTNET, ledgerSequence: async () => this.latestLedger };

        // Record submissions and hand them to the test's stub
        const submitter = {
            submitAuthorized: async (operation: xdr.Operation) => {
                this.submitted.push(operation);
                return this.nextSubmit(operation);
            },
        } as unknown as Submitter;

        // Swap the fakes into the server's Stellar clients
        (stellar as unknown as { clients: object }).clients = { chain, submitter, escrow: new EscrowClient(ESCROW_ID, submitter) };
        process.env.CHANNEL_SECRET = Keypair.random().secret();
        process.env.FEE_SECRET = Keypair.random().secret();
        Object.defineProperty(stellar, "usdcContractId", { value: USDC_ID, configurable: true });
    }

    /**
     * Queues a contract event in the next ledger and returns that ledger.
     * @param name - The event name, the first topic
     * @param escrowId - The escrow id topic
     * @param data - The event's data fields
     */
    emit(name: string, escrowId: bigint, data: Record<string, xdr.ScVal>): number {
        // Advance the ledger and encode the data as a sorted map
        const ledger = ++this.latestLedger;
        const entries = Object.keys(data)
            .sort()
            .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: data[key] }));

        // Queue the event as RPC returns it
        this.events.push({
            id: `${String(BigInt(ledger) << 32n).padStart(19, "0")}-${String(this.events.length).padStart(10, "0")}`,
            type: "contract",
            ledger,
            ledgerClosedAt: new Date(ledger * 5_000).toISOString(),
            transactionIndex: 0,
            operationIndex: 0,
            txHash: `${ledger}`.padStart(64, "0"),
            contractId: new Contract(ESCROW_ID),
            topic: [xdr.ScVal.scvSymbol(name), nativeToScVal(escrowId, { type: "u64" })],
            value: xdr.ScVal.scvMap(entries),
        });

        return ledger;
    }

    /** Returns the events after the request's position, up to its limit, with a cursor like RPC's. */
    private page(request: { startLedger?: number; cursor?: string; limit: number }): rpc.Api.GetEventsResponse {
        // Find the events after the cursor or from the start ledger
        const after = request.cursor ? Number(BigInt(request.cursor.split("-")[0]) >> 32n) : (request.startLedger ?? 0) - 1;
        const events = this.events.filter((event) => event.ledger > after).slice(0, request.limit);

        // Point the cursor at the last event of a full page, or at the latest ledger
        const full = events.length === request.limit;
        const cursor = full ? `${events[events.length - 1].id.split("-")[0]}-0` : cursorAt(this.latestLedger);

        return { events, cursor, latestLedger: this.latestLedger, oldestLedger: 900, latestLedgerCloseTime: "0", oldestLedgerCloseTime: "0" };
    }
}

/** Empties every journal table. */
export async function resetDatabase(): Promise<void> {
    await prisma.$executeRawUnsafe(
        "TRUNCATE sellers, quotes, chain_events, ingest_cursor, escrows, escrow_transitions, chain_transactions, manifests, disputes, webhook_deliveries RESTART IDENTITY CASCADE",
    );
}
