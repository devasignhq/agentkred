// Chain reader tests against a stubbed RPC server: balances, ledger time and waiting for a deadline.

import { describe, expect, it } from "vitest";
import { Chain } from "../src/chain.js";
import { TESTNET } from "../src/network.js";

/** Builds a chain reader whose RPC server is replaced by `server`. */
function chainWith(server: object): Chain {
    // Create the reader with no poll delay and swap in the stub
    const chain = new Chain({ ...TESTNET, pollIntervalMs: 0 });
    (chain as unknown as { server: object }).server = server;
    return chain;
}

describe("Chain", () => {
    it("reads a USDC balance in stroops", async () => {
        const chain = chainWith({ getAssetBalance: async () => ({ balanceEntry: { amount: "274000000" } }) });

        expect(await chain.usdcBalance("GBUYER")).toBe(274_000_000n);
    });

    it("reports zero USDC for an account with no trustline", async () => {
        const chain = chainWith({
            getAssetBalance: async () => {
                throw new Error("Trustline for USDC not found");
            },
        });

        expect(await chain.usdcBalance("GFEES")).toBe(0n);
    });

    it("reads ledger close time given as seconds or as an ISO timestamp", async () => {
        expect(await chainWith({ getLatestLedger: async () => ({ closeTime: "1700000000" }) }).ledgerTime()).toBe(1_700_000_000);
        expect(await chainWith({ getLatestLedger: async () => ({ closeTime: "2023-11-14T22:13:20Z" }) }).ledgerTime()).toBe(1_700_000_000);
    });

    it("waits until ledger time reaches the target, ticking on every poll before it", async () => {
        // Advance the stubbed ledger five seconds per read
        let now = 100;
        const chain = chainWith({ getLatestLedger: async () => ({ closeTime: String((now += 5)) }) });

        // Wait for 120 and collect the ticks
        const ticks: number[] = [];
        const reached = await chain.waitForLedgerTime(120, (tick) => ticks.push(tick));

        expect(ticks).toEqual([105, 110, 115]);
        expect(reached).toBe(120);
    });
});
