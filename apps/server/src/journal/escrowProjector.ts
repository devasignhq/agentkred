// Projects escrow contract events into escrow and transition rows, appending and never editing.

import { EscrowEvent } from "@agentkred/shared";
import { Tx } from "../config/db.js";
import { EscrowState, Prisma } from "../generated/prisma/client.js";
import { WebhookService } from "../services/webhookService.js";

/** Where and when a contract event was emitted. */
export interface EventMeta {
    id: string;
    ledger: number;
    closedAt: number;
    txHash: string;
}

export interface EscrowRow {
    id: bigint;
    buyer: string;
    seller: string;
    asset: string;
    cap: bigint;
    floor: bigint;
    jobId: string;
    quoteHash: string;
    acceptBy: number;
    lockedAt: number;
    lockTx: string;
}

export interface TransitionRow {
    escrowId: bigint;
    eventId: string;
    state: EscrowState;
    at: number;
    ledger: number;
    txHash: string;
    data: Record<string, string | number>;
}

export class EscrowProjector {
    /** Maps one decoded event to the rows it adds, or null for events that change no escrow. */
    static toRows(event: EscrowEvent, meta: EventMeta): { escrow?: EscrowRow; transition: TransitionRow } | null {
        // Skip contract upgrades, which belong to no escrow
        if (event.name === "contract_upgraded") {
            return null;
        }

        // Describe the transition common to every escrow event
        const transition = (state: EscrowState, data: TransitionRow["data"]): TransitionRow => ({
            escrowId: event.escrowId,
            eventId: meta.id,
            state,
            at: meta.closedAt,
            ledger: meta.ledger,
            txHash: meta.txHash,
            data,
        });

        // Map each event to its state and data
        switch (event.name) {
            case "escrow_locked":
                return {
                    escrow: {
                        id: event.escrowId,
                        buyer: event.buyer,
                        seller: event.seller,
                        asset: event.asset,
                        cap: event.cap,
                        floor: event.floor,
                        jobId: event.jobId,
                        quoteHash: event.quoteHash,
                        acceptBy: event.acceptBy,
                        lockedAt: meta.closedAt,
                        lockTx: meta.txHash,
                    },
                    transition: transition("Locked", { acceptBy: event.acceptBy }),
                };
            case "escrow_accepted":
                return { transition: transition("Accepted", { deliverBy: event.deliverBy }) };
            case "escrow_delivered":
                return { transition: transition("Delivered", { manifestHash: event.manifestHash, disputeBy: event.disputeBy }) };
            case "escrow_acknowledged":
                return { transition: transition("Acknowledged", {}) };
            case "escrow_disputed":
                return { transition: transition("Disputed", { completeness: event.completeness }) };
            case "escrow_settled":
                return {
                    transition: transition("Released", {
                        outcome: event.outcome,
                        completeness: event.completeness,
                        payout: event.payout.toString(),
                        remainder: event.remainder.toString(),
                    }),
                };
            case "escrow_refunded":
                return { transition: transition("Refunded", { reason: event.reason, amount: event.amount.toString() }) };
        }
    }

    /**
     * Appends an event's rows to the projection inside `tx`, skipping rows already projected.
     * @param notify - Whether to queue webhooks for the transition; a rebuild passes false
     */
    static async project(tx: Tx, event: EscrowEvent, meta: EventMeta, notify: boolean): Promise<void> {
        // Map the event, ignoring ones that change no escrow
        const rows = this.toRows(event, meta);
        if (!rows) {
            return;
        }

        // Insert the escrow on lock, and skip events of escrows locked before the journal's first ledger
        if (rows.escrow) {
            await tx.escrow.createMany({ data: [rows.escrow], skipDuplicates: true });
        } else if ((await tx.escrow.count({ where: { id: rows.transition.escrowId } })) === 0) {
            return;
        }

        // Insert the transition
        const inserted = await tx.escrowTransition.createMany({
            data: [{ ...rows.transition, data: rows.transition.data as Prisma.InputJsonObject }],
            skipDuplicates: true,
        });

        // Queue webhooks for a transition seen for the first time
        if (notify && inserted.count > 0) {
            await WebhookService.enqueue(tx, rows.transition);
        }
    }
}
