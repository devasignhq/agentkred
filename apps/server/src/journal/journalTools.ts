// Journal maintenance: rebuild the projection from stored events, and verify it against a replay and the chain.

import { EscrowView } from "@agentkred/shared";
import { prisma } from "../config/db.js";
import { stellar } from "../config/stellar.js";
import { ChainIngestor, INGEST_LOCK_KEY } from "./chainIngestor.js";
import { EscrowFold, EscrowRecord, FoldTransition } from "./escrowFold.js";
import { EscrowProjector, EscrowRow } from "./escrowProjector.js";

/** Fields compared between the journal and the contract's stored escrow. */
const CHAIN_FIELDS = [
    "state",
    "buyer",
    "seller",
    "asset",
    "cap",
    "floor",
    "jobId",
    "quoteHash",
    "lockedAt",
    "acceptBy",
    "acceptedAt",
    "deliverBy",
    "deliveredAt",
    "disputeBy",
    "manifestHash",
    "acknowledgedAt",
    "disputedAt",
    "completeness",
    "closedAt",
] as const;

export interface Divergence {
    escrowId: string;
    source: "replay" | "chain";
    field: string;
    journal: unknown;
    other: unknown;
}

export class JournalTools {
    /**
     * Drops the escrow projection and re-projects every stored event in chain order, without sending webhooks.
     * @returns The number of events replayed
     */
    static async rebuild(): Promise<number> {
        return prisma.$transaction(
            async (tx) => {
                // Hold the ingest lock so no event lands mid-rebuild
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(${INGEST_LOCK_KEY})`;

                // Drop the projection
                await tx.escrowTransition.deleteMany();
                await tx.escrow.deleteMany();

                // Re-project every stored event in chain order
                const rows = await tx.chainEvent.findMany({ orderBy: [{ ledger: "asc" }, { id: "asc" }] });
                for (const row of rows) {
                    const { event, meta } = ChainIngestor.decodeStored(row);
                    if (event) {
                        await EscrowProjector.project(tx, event, meta, false);
                    }
                }

                return rows.length;
            },
            { maxWait: 10_000, timeout: 600_000 },
        );
    }

    /**
     * Compares the live projection with an in-memory replay of the stored events and with each escrow on chain.
     * @returns Every field where they disagree; an empty list means zero divergence
     */
    static async verify(): Promise<{ escrows: number; divergences: Divergence[] }> {
        // Fold the live projection and an in-memory replay of the stored events
        const live = await this.liveRecords();
        const replayed = await this.replayRecords();
        const divergences: Divergence[] = [];

        // Compare the projection with the replay, field by field
        for (const id of new Set([...live.keys(), ...replayed.keys()])) {
            const journal = live.get(id);
            const replay = replayed.get(id);
            if (JSON.stringify(journal) !== JSON.stringify(replay)) {
                divergences.push({ escrowId: id, source: "replay", field: "record", journal, other: replay });
            }
        }

        // Compare the projection with each escrow the contract stores, simulating from AgentKred's channel account
        const reader = stellar.sponsor().channel.publicKey();
        for (const [id, journal] of live) {
            divergences.push(...(await this.compareWithChain(id, journal, reader)));
        }

        return { escrows: live.size, divergences };
    }

    /** Folds every escrow in the live projection. */
    private static async liveRecords(): Promise<Map<string, EscrowRecord>> {
        // Load each escrow with its transitions and fold it
        const escrows = await prisma.escrow.findMany({ include: { transitions: true }, orderBy: { id: "asc" } });
        return new Map(
            escrows.map((escrow) => [
                escrow.id.toString(),
                EscrowFold.fold(escrow, escrow.transitions.map((row) => ({ ...row, data: row.data as FoldTransition["data"] }))),
            ]),
        );
    }

    /** Replays every stored event in memory, through the same mapping the projector uses, and folds the result. */
    private static async replayRecords(): Promise<Map<string, EscrowRecord>> {
        // Map each stored event to its rows, keeping only escrows whose lock was read
        const escrows = new Map<string, { escrow: EscrowRow; transitions: FoldTransition[] }>();
        const rows = await prisma.chainEvent.findMany({ orderBy: [{ ledger: "asc" }, { id: "asc" }] });
        for (const row of rows) {
            const { event, meta } = ChainIngestor.decodeStored(row);
            const mapped = event ? EscrowProjector.toRows(event, meta) : null;
            if (!mapped) {
                continue;
            }
            const id = mapped.transition.escrowId.toString();
            if (mapped.escrow) {
                escrows.set(id, { escrow: mapped.escrow, transitions: [] });
            }
            escrows.get(id)?.transitions.push(mapped.transition);
        }

        // Fold each replayed escrow
        return new Map([...escrows].map(([id, { escrow, transitions }]) => [id, EscrowFold.fold(escrow, transitions)]));
    }

    /** Returns the fields where the journal's record differs from the escrow the contract stores. */
    private static async compareWithChain(id: string, journal: EscrowRecord, reader: string): Promise<Divergence[]> {
        // Read the escrow from the contract, reporting an unreadable one as a divergence
        let chain: EscrowView;
        try {
            chain = await stellar.escrow.get(BigInt(id), reader);
        } catch (error) {
            return [{ escrowId: id, source: "chain", field: "get_escrow", journal: journal.state, other: (error as Error).message.split("\n")[0] }];
        }

        // Normalize the chain's amounts to the journal's strings and compare each field
        const normalized: Record<string, unknown> = { ...chain, cap: chain.cap.toString(), floor: chain.floor.toString() };
        return CHAIN_FIELDS.filter((field) => journal[field] !== normalized[field]).map((field) => ({
            escrowId: id,
            source: "chain" as const,
            field,
            journal: journal[field],
            other: normalized[field],
        }));
    }
}
