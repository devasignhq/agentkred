// Quote encoding tests, including the hash vector shared with the contract's Rust tests.

import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { QuoteTerms, Quotes } from "../src/quote.js";

const QUOTE_HASH_VECTOR = "59372ce26ddb1a34f8f3567c18798cc49577780600a9ba843a36b099fdba0e12";

const seller = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));

/** Returns the fixed terms used by `quote_hash_matches_the_cross_language_vector` in the contract tests. */
function vectorTerms(): QuoteTerms {
    return {
        seller: seller.publicKey(),
        asset: StrKey.encodeContract(Buffer.alloc(32, 2)),
        cap: 10_000_000n,
        floor: 2_000_000n,
        schedule: [
            { completeness: 0, payout: 2_000_000n },
            { completeness: 50, payout: 6_000_000n },
            { completeness: 100, payout: 10_000_000n },
        ],
        acceptS: 30,
        deliverS: 60,
        disputeS: 30,
        jobId: Buffer.alloc(32, 3),
    };
}

describe("Quotes", () => {
    it("hashes the terms exactly as the contract does", () => {
        expect(Quotes.hash(vectorTerms()).toString("hex")).toBe(QUOTE_HASH_VECTOR);
    });

    it("signs a quote that verifies against the seller's key", () => {
        // Sign the vector terms as the seller
        const signed = Quotes.sign(vectorTerms(), seller);

        // Check the signature and hash verify
        expect(signed.quoteHash.toString("hex")).toBe(QUOTE_HASH_VECTOR);
        expect(Quotes.verify(signed)).toBe(true);
    });

    it("rejects a quote whose terms changed after signing", () => {
        // Sign, then raise the cap
        const signed = Quotes.sign(vectorTerms(), seller);
        signed.terms = { ...signed.terms, cap: signed.terms.cap + 1n };

        // Check the verification fails
        expect(Quotes.verify(signed)).toBe(false);
    });

    it("rejects a signature from another key", () => {
        // Replace the signature with one from a different key
        const signed = Quotes.sign(vectorTerms(), seller);
        const forger = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
        signed.signature = Buffer.from(forger.sign(signed.quoteHash));

        // Check the verification fails
        expect(Quotes.verify(signed)).toBe(false);
    });

    it("refuses to sign for a seller that is not the signing key", () => {
        const stranger = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
        expect(() => Quotes.sign(vectorTerms(), stranger)).toThrow("does not match");
    });

    it("looks up payouts only at quoted completeness values", () => {
        const { schedule } = vectorTerms();
        expect(Quotes.payoutAt(schedule, 50)).toBe(6_000_000n);
        expect(Quotes.payoutAt(schedule, 30)).toBeNull();
    });
});
