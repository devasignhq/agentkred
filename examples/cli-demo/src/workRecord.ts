// Builds a work record from a closed escrow and its settle or refund event, and prints it.

import { Chain } from "./chain.js";
import { Config } from "./config.js";
import { EscrowView, TerminalEvent } from "./escrowClient.js";
import { Log } from "./log.js";

export type Outcome = "acknowledged" | "silent" | "disputed" | "refunded-not-accepted" | "refunded-not-delivered";

export interface WorkRecord {
    escrowId: string;
    outcome: Outcome;
    meaning: string;
    buyer: string;
    seller: string;
    asset: string;
    cap: string;
    floor: string;
    completeness: number | null;
    payout: string;
    returnedToBuyer: string;
    paymentRef: string;
    closeTx: string;
    jobId: string;
    quoteHash: string;
    manifestHash: string | null;
    lockedAt: number;
    acceptBy: number;
    acceptedAt: number | null;
    deliverBy: number | null;
    deliveredAt: number | null;
    disputeBy: number | null;
    acknowledgedAt: number | null;
    disputedAt: number | null;
    closedAt: number | null;
}

export class WorkRecords {
    /**
     * Builds the work record for a closed escrow from its terminal event.
     * @param escrowId - The escrow id
     * @param escrow - The escrow as read from the contract after closing
     * @param closeTx - Hash of the settle or refund transaction
     * @param event - The settle or refund event that transaction emitted
     * @returns The work record
     */
    static build(escrowId: bigint, escrow: EscrowView, closeTx: string, event: TerminalEvent): WorkRecord {
        // Take the outcome and the split from the terminal event
        const outcome = this.outcome(event);
        const payout = event.kind === "settled" ? event.payout : 0n;
        const returned = event.kind === "settled" ? event.remainder : event.amount;

        return {
            escrowId: escrowId.toString(),
            outcome,
            meaning: this.meaning(event),
            buyer: escrow.buyer,
            seller: escrow.seller,
            asset: `${Config.usdc.getCode()} (${escrow.asset})`,
            cap: Chain.format(escrow.cap),
            floor: Chain.format(escrow.floor),
            completeness: event.kind === "settled" ? event.completeness : null,
            payout: Chain.format(payout),
            returnedToBuyer: Chain.format(returned),
            paymentRef: `escrow ${escrowId} + ${closeTx}`,
            closeTx,
            jobId: escrow.jobId,
            quoteHash: escrow.quoteHash,
            manifestHash: escrow.manifestHash,
            lockedAt: escrow.lockedAt,
            acceptBy: escrow.acceptBy,
            acceptedAt: escrow.acceptedAt,
            deliverBy: escrow.deliverBy,
            deliveredAt: escrow.deliveredAt,
            disputeBy: escrow.disputeBy,
            acknowledgedAt: escrow.acknowledgedAt,
            disputedAt: escrow.disputedAt,
            closedAt: escrow.closedAt,
        };
    }

    /** Prints a work record to the terminal. */
    static print(record: WorkRecord): void {
        // Print the outcome, the parties and the split
        Log.step(`Work record for escrow ${record.escrowId}`);
        Log.info("outcome", `${record.outcome} (${record.meaning})`);
        Log.info("buyer", record.buyer);
        Log.info("seller", record.seller);
        Log.info("asset", record.asset);
        Log.info("cap / floor", `${record.cap} / ${record.floor}`);
        Log.info("completeness", record.completeness == null ? "-" : `${record.completeness}%`);
        Log.info("to seller", record.payout);
        Log.info("to buyer", record.returnedToBuyer);

        // Print the payment reference and evidence
        Log.info("payment ref", record.paymentRef);
        Log.info("quote hash", record.quoteHash);
        Log.info("manifest hash", record.manifestHash ?? "none (never delivered)");

        // Print the clocks as set and as met
        Log.info("locked at", String(record.lockedAt));
        Log.info("accepted", this.met(record.acceptedAt, record.acceptBy));
        Log.info("delivered", this.met(record.deliveredAt, record.deliverBy));
        Log.info("acknowledged", record.acknowledgedAt == null ? "no" : String(record.acknowledgedAt));
        Log.info("disputed", record.disputedAt == null ? "no" : String(record.disputedAt));
        Log.info("closed at", String(record.closedAt ?? "-"));
    }

    /** Formats a transition time against its deadline, as met, missed or not reached. */
    static met(time: number | null, deadline: number | null): string {
        // Report a deadline that was never set
        if (deadline == null) {
            return "- (clock never started)";
        }

        // Report the time it was met, or that it was missed
        return time == null ? `no (deadline ${deadline})` : `${time} (deadline ${deadline}, on time)`;
    }

    /** Names the record's outcome from the terminal event. */
    private static outcome(event: TerminalEvent): Outcome {
        // Map a settlement by how it reached its payout
        if (event.kind === "settled") {
            return event.outcome === "Acknowledged" ? "acknowledged" : event.outcome === "Silent" ? "silent" : "disputed";
        }

        return event.reason === "NotAccepted" ? "refunded-not-accepted" : "refunded-not-delivered";
    }

    /** Describes the outcome in one line. */
    private static meaning(event: TerminalEvent): string {
        // Describe each settlement outcome
        if (event.kind === "settled") {
            if (event.outcome === "Acknowledged") {
                return "buyer acknowledged the delivery; cap paid to seller";
            }
            if (event.outcome === "Silent") {
                return "dispute window closed with no buyer response; cap paid to seller";
            }
            return `buyer disputed at ${event.completeness}% complete; schedule price paid to seller, rest returned to buyer`;
        }

        // Describe each refund reason
        return event.reason === "NotAccepted"
            ? "seller did not accept by accept-by; cap returned to buyer"
            : "seller accepted but did not deliver by deliver-by; cap returned to buyer";
    }
}
