// Auth entries: signing a call tree, reading it back, and comparing call trees argument by argument.

import { Contract, Keypair, Networks, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { AuthEntries, AuthorizedCall } from "../src/auth.js";
import { EscrowEvents } from "../src/events.js";
import { Quotes, SignedQuote } from "../src/quote.js";

const ESCROW = StrKey.encodeContract(Buffer.alloc(32, 1));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 2));

/** Returns a `transfer` call of `amount` from `from` to the escrow. */
function transfer(from: string, amount: bigint): AuthorizedCall {
    return AuthEntries.callOf(
        new Contract(TOKEN).call("transfer", nativeToScVal(from, { type: "address" }), nativeToScVal(ESCROW, { type: "address" }), nativeToScVal(amount, { type: "i128" })),
    );
}

describe("AuthEntries", () => {
    it("signs a call tree and reads back its signer, expiry and calls", async () => {
        // Sign an accept call with a transfer beneath it
        const signer = Keypair.random();
        const call = { ...AuthEntries.callOf(new Contract(ESCROW).call("accept", nativeToScVal(7n, { type: "u64" }))), subCalls: [transfer(signer.publicKey(), 5n)] };
        const entry = await AuthEntries.sign(call, signer, 1_000, Networks.TESTNET);

        // Round-trip it through base64 and describe it
        const view = AuthEntries.describe(AuthEntries.fromBase64(AuthEntries.toBase64(entry)));

        expect(view?.signer).toBe(signer.publicKey());
        expect(view?.expirationLedger).toBe(1_000);
        expect(view && AuthEntries.sameCall(view.call, call)).toBe(true);
    });

    it("tells call trees apart by contract, method, arguments and sub-calls", () => {
        const buyer = Keypair.random().publicKey();
        const accept = AuthEntries.callOf(new Contract(ESCROW).call("accept", nativeToScVal(7n, { type: "u64" })));

        expect(AuthEntries.sameCall(accept, { ...accept })).toBe(true);
        expect(AuthEntries.sameCall(accept, { ...accept, contract: TOKEN })).toBe(false);
        expect(AuthEntries.sameCall(accept, { ...accept, method: "deliver" })).toBe(false);
        expect(AuthEntries.sameCall(accept, { ...accept, args: [nativeToScVal(8n, { type: "u64" })] })).toBe(false);
        expect(AuthEntries.sameCall(accept, { ...accept, args: [nativeToScVal(7n, { type: "u128" })] })).toBe(false);
        expect(AuthEntries.sameCall({ ...accept, subCalls: [transfer(buyer, 5n)] }, { ...accept, subCalls: [transfer(buyer, 6n)] })).toBe(false);
        expect(AuthEntries.sameCall(accept, { ...accept, subCalls: [transfer(buyer, 5n)] })).toBe(false);
    });
});

describe("Quotes JSON", () => {
    it("round-trips a signed quote through its wire form", () => {
        // Sign a quote and convert it both ways
        const seller = Keypair.random();
        const quote: SignedQuote = Quotes.sign(
            {
                seller: seller.publicKey(),
                asset: TOKEN,
                cap: 10_000_000n,
                floor: 2_000_000n,
                schedule: [
                    { completeness: 0, payout: 2_000_000n },
                    { completeness: 100, payout: 10_000_000n },
                ],
                acceptS: 60,
                deliverS: 600,
                disputeS: 300,
                jobId: Buffer.alloc(32, 9),
            },
            seller,
        );
        const json = Quotes.toJson(quote);

        expect(json.terms.cap).toBe("10000000");
        expect(Quotes.verify(Quotes.fromJson(json))).toBe(true);
    });

    it("rejects byte fields of the wrong length", () => {
        const json = { terms: { seller: "", asset: "", cap: "1", floor: "0", schedule: [], acceptS: 1, deliverS: 1, disputeS: 1, jobId: "ab" }, quoteHash: "", signature: "" };

        expect(() => Quotes.fromJson(json)).toThrow("jobId must be 32 bytes");
    });
});

describe("EscrowEvents.decode", () => {
    /** Builds an event's topics and data map. */
    function event(name: string, data: Record<string, xdr.ScVal>, withId = true): [xdr.ScVal[], xdr.ScVal] {
        const entries = Object.keys(data)
            .sort()
            .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: data[key] }));
        const topics = withId ? [xdr.ScVal.scvSymbol(name), nativeToScVal(3n, { type: "u64" })] : [xdr.ScVal.scvSymbol(name)];
        return [topics, xdr.ScVal.scvMap(entries)];
    }

    it("decodes a lock with every term", () => {
        const buyer = Keypair.random().publicKey();
        const decoded = EscrowEvents.decode(
            ...event("escrow_locked", {
                buyer: nativeToScVal(buyer, { type: "address" }),
                seller: nativeToScVal(buyer, { type: "address" }),
                asset: nativeToScVal(TOKEN, { type: "address" }),
                cap: nativeToScVal(10n, { type: "i128" }),
                floor: nativeToScVal(2n, { type: "i128" }),
                job_id: xdr.ScVal.scvBytes(Buffer.alloc(32, 4)),
                quote_hash: xdr.ScVal.scvBytes(Buffer.alloc(32, 5)),
                accept_by: nativeToScVal(500n, { type: "u64" }),
            }),
        );

        expect(decoded).toEqual({
            name: "escrow_locked",
            escrowId: 3n,
            buyer,
            seller: buyer,
            asset: TOKEN,
            cap: 10n,
            floor: 2n,
            jobId: "04".repeat(32),
            quoteHash: "05".repeat(32),
            acceptBy: 500,
        });
    });

    it("decodes progress events and the upgrade event, and ignores unknown names", () => {
        expect(EscrowEvents.decode(...event("escrow_accepted", { deliver_by: nativeToScVal(9n, { type: "u64" }) }))).toEqual({ name: "escrow_accepted", escrowId: 3n, deliverBy: 9 });
        expect(EscrowEvents.decode(...event("escrow_disputed", { buyer: nativeToScVal(ESCROW, { type: "address" }), completeness: nativeToScVal(50, { type: "u32" }) }))).toMatchObject({
            completeness: 50,
        });
        expect(
            EscrowEvents.decode(...event("contract_upgraded", { new_wasm_hash: xdr.ScVal.scvBytes(Buffer.alloc(32, 1)), admin: nativeToScVal(ESCROW, { type: "address" }) }, false)),
        ).toMatchObject({ name: "contract_upgraded", newWasmHash: "01".repeat(32) });
        expect(EscrowEvents.decode(...event("transfer", {}))).toBeNull();
    });
});
