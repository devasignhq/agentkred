// Rejected-lock suite: forged quotes, mismatched arguments, expired auth and out-of-range caps fail before submission.

import { Keypair } from "@stellar/stellar-sdk";
import { Quotes } from "@agentkred/shared";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/config/errors.js";
import { LockContext, LockValidator } from "../../src/utils/lockValidator.js";
import { ESCROW_ID, USDC_ID, escrowClient, lockCall, signAuth, signedQuote } from "../support/fixtures.js";

const seller = Keypair.random();
const buyer = Keypair.random();

/** Returns a context with a listing covering 0.5 to 2 USDC at ledger 100. */
function context(overrides: Partial<LockContext> = {}): LockContext {
    return {
        listing: { capMin: 5_000_000n, capMax: 20_000_000n },
        currentLedger: 100,
        quoteUsed: false,
        escrow: escrowClient,
        usdcContractId: USDC_ID,
        ...overrides,
    };
}

/** Runs the validator and returns the error code it throws. */
function rejection(run: () => unknown): string {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        return `${(error as ApiError).status} ${(error as ApiError).code}`;
    }
    throw new Error("Expected the lock to be rejected");
}

describe("LockValidator", () => {
    it("accepts the buyer's auth for exactly this quote and returns the buyer", async () => {
        const quote = signedQuote(seller);
        const auth = await signAuth(lockCall(buyer.publicKey(), quote), buyer);

        const valid = LockValidator.validate(Quotes.toJson(quote), auth, context());

        expect(valid.buyer).toBe(buyer.publicKey());
        expect(valid.quote.quoteHash.equals(quote.quoteHash)).toBe(true);
    });

    it("rejects a forged quote: another key's signature or terms changed after signing", async () => {
        // Sign the genuine hash with an impostor's key, and separately raise the cap after signing
        const genuine = signedQuote(seller);
        const impostorSignature = Buffer.from(Keypair.random().sign(genuine.quoteHash)).toString("hex");
        const tampered = Quotes.toJson(genuine);
        tampered.terms.cap = "15000000";
        const auth = await signAuth(lockCall(buyer.publicKey(), genuine), buyer);

        expect(rejection(() => LockValidator.validate({ ...Quotes.toJson(genuine), signature: impostorSignature }, auth, context()))).toBe("422 forged_quote");
        expect(rejection(() => LockValidator.validate(tampered, auth, context()))).toBe("422 forged_quote");
    });

    it("rejects mismatched arguments: another quote, a different transfer or a missing transfer", async () => {
        // Sign auth for a different job, for a smaller transfer, and with no transfer at all
        const quote = signedQuote(seller);
        const otherQuote = signedQuote(seller, { jobId: Buffer.alloc(32, 8) });
        const forOtherQuote = await signAuth(lockCall(buyer.publicKey(), otherQuote), buyer);
        const smallerTransfer = await signAuth(lockCall(buyer.publicKey(), quote, 1n), buyer);
        const noTransfer = await signAuth({ ...lockCall(buyer.publicKey(), quote), subCalls: [] }, buyer);

        for (const auth of [forOtherQuote, smallerTransfer, noTransfer]) {
            expect(rejection(() => LockValidator.validate(Quotes.toJson(quote), auth, context()))).toBe("422 mismatched_arguments");
        }
    });

    it("rejects auth signed by someone other than the buyer it names", async () => {
        const quote = signedQuote(seller);
        const auth = await signAuth(lockCall(buyer.publicKey(), quote), Keypair.random());

        expect(rejection(() => LockValidator.validate(Quotes.toJson(quote), auth, context()))).toBe("422 mismatched_arguments");
    });

    it("rejects expired auth: valid for fewer than the margin's ledgers", async () => {
        const quote = signedQuote(seller);
        const auth = await signAuth(lockCall(buyer.publicKey(), quote), buyer, 102);

        expect(rejection(() => LockValidator.validate(Quotes.toJson(quote), auth, context()))).toBe("422 auth_expired");
    });

    it("rejects a cap outside the listed range", async () => {
        // Quote 5 USDC, and separately 0.1 USDC, against a 0.5 to 2 USDC listing
        for (const cap of [50_000_000n, 1_000_000n]) {
            const quote = signedQuote(seller, { cap, floor: 0n, schedule: [{ completeness: 0, payout: 0n }, { completeness: 100, payout: cap }] });
            const auth = await signAuth(lockCall(buyer.publicKey(), quote), buyer);

            expect(rejection(() => LockValidator.validate(Quotes.toJson(quote), auth, context()))).toBe("422 cap_out_of_range");
        }
    });

    it("rejects an unlisted seller, another asset, a reused quote and malformed input", async () => {
        const quote = signedQuote(seller);
        const auth = await signAuth(lockCall(buyer.publicKey(), quote), buyer);
        const otherAsset = signedQuote(seller, { asset: ESCROW_ID });

        expect(rejection(() => LockValidator.validate(Quotes.toJson(quote), auth, context({ listing: null })))).toBe("422 unknown_seller");
        expect(rejection(() => LockValidator.validate(Quotes.toJson(otherAsset), auth, context()))).toBe("422 wrong_asset");
        expect(rejection(() => LockValidator.validate(Quotes.toJson(quote), auth, context({ quoteUsed: true })))).toBe("409 quote_already_locked");
        expect(rejection(() => LockValidator.validate(Quotes.toJson(quote), "not-xdr", context()))).toBe("400 malformed_auth");
        expect(rejection(() => LockValidator.validate({ ...Quotes.toJson(quote), quoteHash: "ab" }, auth, context()))).toBe("400 malformed_quote");
    });
});
