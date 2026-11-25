// Folds an escrow's lock row and its transitions into the escrow's current view.

import { EscrowState } from "../generated/prisma/client.js";
import { EscrowRow, TransitionRow } from "./escrowProjector.js";

export type FoldTransition = Omit<TransitionRow, "escrowId">;

/** An escrow as the journal sees it: terms, current state, every clock and the outcome. */
export interface EscrowRecord {
    id: string;
    state: EscrowState;
    buyer: string;
    seller: string;
    asset: string;
    cap: string;
    floor: string;
    jobId: string;
    quoteHash: string;
    lockedAt: number;
    lockTx: string;
    acceptBy: number;
    acceptedAt: number | null;
    deliverBy: number | null;
    deliveredAt: number | null;
    disputeBy: number | null;
    manifestHash: string | null;
    acknowledgedAt: number | null;
    disputedAt: number | null;
    completeness: number | null;
    closedAt: number | null;
    settlement: { outcome: string; completeness: number; payout: string; remainder: string } | null;
    refund: { reason: string; amount: string } | null;
    transitions: { state: EscrowState; at: number; ledger: number; txHash: string }[];
}

export class EscrowFold {
    /** Builds the current view of an escrow from its lock row and its transitions in any order. */
    static fold(escrow: EscrowRow, transitions: FoldTransition[]): EscrowRecord {
        // Start from the terms fixed at lock
        const record: EscrowRecord = {
            id: escrow.id.toString(),
            state: "Locked",
            buyer: escrow.buyer,
            seller: escrow.seller,
            asset: escrow.asset,
            cap: escrow.cap.toString(),
            floor: escrow.floor.toString(),
            jobId: escrow.jobId,
            quoteHash: escrow.quoteHash,
            lockedAt: escrow.lockedAt,
            lockTx: escrow.lockTx,
            acceptBy: escrow.acceptBy,
            acceptedAt: null,
            deliverBy: null,
            deliveredAt: null,
            disputeBy: null,
            manifestHash: null,
            acknowledgedAt: null,
            disputedAt: null,
            completeness: null,
            closedAt: null,
            settlement: null,
            refund: null,
            transitions: [],
        };

        // Apply the transitions in chain order
        const ordered = [...transitions].sort((a, b) => a.ledger - b.ledger || a.eventId.localeCompare(b.eventId));
        for (const transition of ordered) {
            this.apply(record, transition);
            record.state = transition.state;
            record.transitions.push({ state: transition.state, at: transition.at, ledger: transition.ledger, txHash: transition.txHash });
        }

        return record;
    }

    /** Records the clocks and outcome that a single transition sets. */
    private static apply(record: EscrowRecord, transition: FoldTransition): void {
        // Set the fields belonging to the transition's state
        const { at, data } = transition;
        switch (transition.state) {
            case "Accepted":
                record.acceptedAt = at;
                record.deliverBy = Number(data.deliverBy);
                break;
            case "Delivered":
                record.deliveredAt = at;
                record.manifestHash = String(data.manifestHash);
                record.disputeBy = Number(data.disputeBy);
                break;
            case "Acknowledged":
                record.acknowledgedAt = at;
                break;
            case "Disputed":
                record.disputedAt = at;
                record.completeness = Number(data.completeness);
                break;
            case "Released":
                record.closedAt = at;
                record.settlement = {
                    outcome: String(data.outcome),
                    completeness: Number(data.completeness),
                    payout: String(data.payout),
                    remainder: String(data.remainder),
                };
                break;
            case "Refunded":
                record.closedAt = at;
                record.refund = { reason: String(data.reason), amount: String(data.amount) };
                break;
        }
    }
}
