// Prints a work record to the terminal.

import { WorkRecord, WorkRecords } from "@agentkred/shared";
import { Log } from "./log.js";

export class WorkRecordPrinter {
    /** Prints a work record's outcome, split, references and clocks. */
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
        Log.info("accepted", WorkRecords.met(record.acceptedAt, record.acceptBy));
        Log.info("delivered", WorkRecords.met(record.deliveredAt, record.deliverBy));
        Log.info("acknowledged", record.acknowledgedAt == null ? "no" : String(record.acknowledgedAt));
        Log.info("disputed", record.disputedAt == null ? "no" : String(record.disputedAt));
        Log.info("closed at", String(record.closedAt ?? "-"));
    }
}
