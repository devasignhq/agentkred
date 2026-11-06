// Builds a work record from a closed escrow and its closing transaction, and prints it.

import { Chain } from "./chain.js";
import { Config } from "./config.js";
import { EscrowView } from "./escrowClient.js";
import { Log } from "./log.js";

export type Outcome = "acknowledged" | "released" | "refunded";

export interface WorkRecord {
    escrowId: string;
    outcome: Outcome;
    meaning: string;
    buyer: string;
    seller: string;
    asset: string;
    cap: string;
    payout: string;
    paymentRef: string;
    closeTx: string;
    quoteHash: string;
    manifestHash: string | null;
    lockedAt: number;
    deliverBy: number;
    deliveredAt: number | null;
    deliveredOnTime: boolean | null;
    acknowledgedAt: number | null;
    disputeBy: number | null;
    closedAt: number | null;
}

const MEANINGS: Record<Outcome, string> = {
    acknowledged: "buyer acknowledged the delivery; cap paid to seller",
    released: "dispute window closed with no buyer response; cap paid to seller",
    refunded: "no delivery by deliver-by; cap returned to buyer",
};

export class WorkRecords {
    /**
     * Builds the work record for a closed escrow.
     * @param escrowId - The escrow id
     * @param escrow - The escrow as read from the contract after closing
     * @param closeTx - Hash of the settle or refund transaction
     * @returns The work record
     */
    static build(escrowId: bigint, escrow: EscrowView, closeTx: string): WorkRecord {
        // Derive the outcome from the final state and the acknowledgement
        const outcome = this.outcome(escrow);
        const payout = outcome === "refunded" ? 0n : escrow.cap;

        return {
            escrowId: escrowId.toString(),
            outcome,
            meaning: MEANINGS[outcome],
            buyer: escrow.buyer,
            seller: escrow.seller,
            asset: `${Config.usdc.getCode()} (${escrow.asset})`,
            cap: Chain.format(escrow.cap),
            payout: Chain.format(payout),
            paymentRef: `escrow ${escrowId} + ${closeTx}`,
            closeTx,
            quoteHash: escrow.quoteHash,
            manifestHash: escrow.manifestHash,
            lockedAt: escrow.lockedAt,
            deliverBy: escrow.deliverBy,
            deliveredAt: escrow.deliveredAt,
            deliveredOnTime: escrow.deliveredAt == null ? null : escrow.deliveredAt < escrow.deliverBy,
            acknowledgedAt: escrow.acknowledgedAt,
            disputeBy: escrow.disputeBy,
            closedAt: escrow.closedAt,
        };
    }

    /** Prints a work record to the terminal. */
    static print(record: WorkRecord): void {
        // Print the outcome, the parties and the amounts
        Log.step(`Work record for escrow ${record.escrowId}`);
        Log.info("outcome", `${record.outcome} (${record.meaning})`);
        Log.info("buyer", record.buyer);
        Log.info("seller", record.seller);
        Log.info("asset", record.asset);
        Log.info("cap / payout", `${record.cap} / ${record.payout}`);

        // Print the payment reference and evidence
        Log.info("payment ref", record.paymentRef);
        Log.info("quote hash", record.quoteHash);
        Log.info("manifest hash", record.manifestHash ?? "none (never delivered)");

        // Print the clocks as set and as met
        Log.info("locked at", String(record.lockedAt));
        Log.info("deliver-by", String(record.deliverBy));
        Log.info("delivered at", this.timeWithFlag(record.deliveredAt, record.deliveredOnTime));
        Log.info("acknowledged", record.acknowledgedAt == null ? "no" : String(record.acknowledgedAt));
        Log.info("closed at", String(record.closedAt ?? "-"));
    }

    /** Returns the record's outcome from the escrow's final state. */
    private static outcome(escrow: EscrowView): Outcome {
        // Map the refunded state directly
        if (escrow.state === "Refunded") {
            return "refunded";
        }

        // Fail on an escrow that has not been closed
        if (escrow.state !== "Released") {
            throw new Error(`Escrow is still ${escrow.state}; records are written only for closed escrows`);
        }

        return escrow.acknowledgedAt == null ? "released" : "acknowledged";
    }

    /** Formats a ledger time with an on-time or late flag. */
    private static timeWithFlag(time: number | null, onTime: boolean | null): string {
        return time == null ? "-" : `${time} (${onTime ? "on time" : "late"})`;
    }
}
