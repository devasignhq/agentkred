// Work record tests: each terminal event maps to its outcome, split and clocks.

import { describe, expect, it } from "vitest";
import { EscrowView, TerminalEvent } from "../src/escrowClient.js";
import { Amounts } from "../src/network.js";
import { WorkRecords } from "../src/workRecord.js";

/** Returns a closed escrow with every clock set. */
function escrow(): EscrowView {
    return {
        buyer: "GBUYER",
        seller: "GSELLER",
        asset: "CASSET",
        cap: 10_000_000n,
        floor: 2_000_000n,
        schedule: [],
        jobId: "03",
        quoteHash: "aa",
        state: "Released",
        lockedAt: 100,
        acceptBy: 145,
        acceptedAt: 110,
        deliverBy: 170,
        deliveredAt: 120,
        disputeBy: 180,
        manifestHash: "bb",
        acknowledgedAt: null,
        disputedAt: 125,
        completeness: 50,
        closedAt: 126,
    };
}

/** Builds a record for `event` against the test escrow. */
function build(event: TerminalEvent) {
    return WorkRecords.build(7n, escrow(), "cc", event, "USDC");
}

describe("WorkRecords.build", () => {
    it("records a dispute's completeness and the split between seller and buyer", () => {
        const record = build({ kind: "settled", outcome: "Disputed", completeness: 50, payout: 6_000_000n, remainder: 4_000_000n });

        expect(record).toMatchObject({
            escrowId: "7",
            outcome: "disputed",
            asset: "USDC (CASSET)",
            cap: "1.0000000",
            floor: "0.2000000",
            completeness: 50,
            payout: "0.6000000",
            returnedToBuyer: "0.4000000",
            paymentRef: "escrow 7 + cc",
        });
        expect(record.meaning).toContain("50%");
    });

    it("names acknowledged and silent settlements", () => {
        const full = { completeness: 100, payout: 10_000_000n, remainder: 0n };

        expect(build({ kind: "settled", outcome: "Acknowledged", ...full }).outcome).toBe("acknowledged");
        expect(build({ kind: "settled", outcome: "Silent", ...full }).outcome).toBe("silent");
    });

    it("records a refund as nothing paid and the full amount returned", () => {
        const record = build({ kind: "refunded", reason: "NotAccepted", amount: 10_000_000n });

        expect(record).toMatchObject({ outcome: "refunded-not-accepted", completeness: null, payout: "0.0000000", returnedToBuyer: "1.0000000" });
        expect(build({ kind: "refunded", reason: "NotDelivered", amount: 10_000_000n }).outcome).toBe("refunded-not-delivered");
    });
});

describe("WorkRecords.met", () => {
    it("reports a clock as on time, missed or never started", () => {
        expect(WorkRecords.met(110, 145)).toBe("110 (deadline 145, on time)");
        expect(WorkRecords.met(null, 145)).toBe("no (deadline 145)");
        expect(WorkRecords.met(null, null)).toBe("- (clock never started)");
    });
});

describe("Amounts.format", () => {
    it("formats stroops with seven decimals", () => {
        expect(Amounts.format(0n)).toBe("0.0000000");
        expect(Amounts.format(1n)).toBe("0.0000001");
        expect(Amounts.format(274_000_000n)).toBe("27.4000000");
        expect(Amounts.format(-4_000_000n)).toBe("-0.4000000");
    });
});
