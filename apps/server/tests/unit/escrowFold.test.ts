// Projection mapping and folding: every event becomes a transition, and the fold rebuilds the escrow's clocks and outcome.

import { EscrowEvent } from "@agentkred/shared";
import { describe, expect, it } from "vitest";
import { EscrowFold } from "../../src/journal/escrowFold.js";
import { EscrowProjector, EscrowRow, TransitionRow } from "../../src/journal/escrowProjector.js";

let sequence = 0;

/** Maps an event at `ledger` and `at` to its rows. */
function rows(event: EscrowEvent, ledger: number, at: number) {
    sequence++;
    return EscrowProjector.toRows(event, { id: `${String(ledger).padStart(10, "0")}-${sequence}`, ledger, closedAt: at, txHash: `tx${sequence}` })!;
}

const locked = rows(
    { name: "escrow_locked", escrowId: 9n, buyer: "GB", seller: "GS", asset: "CA", cap: 10n, floor: 2n, jobId: "01", quoteHash: "02", acceptBy: 160 },
    10,
    100,
);

describe("EscrowProjector.toRows", () => {
    it("opens the escrow on lock and ignores contract upgrades", () => {
        expect(locked.escrow).toMatchObject({ id: 9n, cap: 10n, lockedAt: 100, acceptBy: 160, lockTx: locked.transition.txHash });
        expect(locked.transition).toMatchObject({ state: "Locked", data: { acceptBy: 160 } });
        expect(EscrowProjector.toRows({ name: "contract_upgraded", newWasmHash: "aa", admin: "GA" }, { id: "x", ledger: 1, closedAt: 1, txHash: "t" })).toBeNull();
    });
});

describe("EscrowFold.fold", () => {
    it("folds a disputed settlement into its clocks, completeness and split", () => {
        // Accept, deliver, dispute at 50 and settle
        const transitions: TransitionRow[] = [
            rows({ name: "escrow_accepted", escrowId: 9n, deliverBy: 200 }, 11, 110).transition,
            rows({ name: "escrow_delivered", escrowId: 9n, manifestHash: "ff", disputeBy: 240 }, 12, 120).transition,
            rows({ name: "escrow_disputed", escrowId: 9n, buyer: "GB", completeness: 50 }, 13, 130).transition,
            rows({ name: "escrow_settled", escrowId: 9n, buyer: "GB", seller: "GS", outcome: "Disputed", completeness: 50, payout: 6n, remainder: 4n }, 14, 140).transition,
        ];

        const record = EscrowFold.fold(locked.escrow as EscrowRow, [locked.transition, ...transitions]);

        expect(record).toMatchObject({
            state: "Released",
            acceptedAt: 110,
            deliverBy: 200,
            deliveredAt: 120,
            manifestHash: "ff",
            disputeBy: 240,
            disputedAt: 130,
            completeness: 50,
            closedAt: 140,
            settlement: { outcome: "Disputed", completeness: 50, payout: "6", remainder: "4" },
            refund: null,
        });
        expect(record.transitions.map((transition) => transition.state)).toEqual(["Locked", "Accepted", "Delivered", "Disputed", "Released"]);
    });

    it("orders transitions by ledger whatever order they arrive in", () => {
        const refunded = rows({ name: "escrow_refunded", escrowId: 9n, buyer: "GB", reason: "NotAccepted", amount: 10n }, 20, 170).transition;

        const record = EscrowFold.fold(locked.escrow as EscrowRow, [refunded, locked.transition]);

        expect(record).toMatchObject({ state: "Refunded", closedAt: 170, refund: { reason: "NotAccepted", amount: "10" }, acceptedAt: null });
    });

    it("records an acknowledgement without a completeness", () => {
        const acknowledged = rows({ name: "escrow_acknowledged", escrowId: 9n, buyer: "GB" }, 15, 150).transition;

        expect(EscrowFold.fold(locked.escrow as EscrowRow, [locked.transition, acknowledged])).toMatchObject({ state: "Acknowledged", acknowledgedAt: 150, completeness: null });
    });
});
