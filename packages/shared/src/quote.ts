// Seller quote terms: the contract's XDR encoding, the quote hash, and the seller's ed25519 signature over it.

import { createHash } from "node:crypto";
import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export interface PayoutStep {
    completeness: number;
    payout: bigint;
}

export interface QuoteTerms {
    seller: string;
    asset: string;
    cap: bigint;
    floor: bigint;
    schedule: PayoutStep[];
    acceptS: number;
    deliverS: number;
    disputeS: number;
    jobId: Buffer;
}

export interface SignedQuote {
    terms: QuoteTerms;
    quoteHash: Buffer;
    signature: Buffer;
}

/** A signed quote as JSON: amounts as decimal stroop strings, byte fields as hex. */
export interface QuoteJson {
    terms: {
        seller: string;
        asset: string;
        cap: string;
        floor: string;
        schedule: { completeness: number; payout: string }[];
        acceptS: number;
        deliverS: number;
        disputeS: number;
        jobId: string;
    };
    quoteHash: string;
    signature: string;
}

export class Quotes {
    /** Converts a signed quote to its JSON wire form. */
    static toJson(quote: SignedQuote): QuoteJson {
        const { terms } = quote;
        return {
            terms: {
                seller: terms.seller,
                asset: terms.asset,
                cap: terms.cap.toString(),
                floor: terms.floor.toString(),
                schedule: terms.schedule.map((step) => ({ completeness: step.completeness, payout: step.payout.toString() })),
                acceptS: terms.acceptS,
                deliverS: terms.deliverS,
                disputeS: terms.disputeS,
                jobId: terms.jobId.toString("hex"),
            },
            quoteHash: quote.quoteHash.toString("hex"),
            signature: quote.signature.toString("hex"),
        };
    }

    /** Parses a signed quote from its JSON wire form, throwing on malformed amounts or byte fields. */
    static fromJson(json: QuoteJson): SignedQuote {
        const { terms } = json;
        return {
            terms: {
                seller: terms.seller,
                asset: terms.asset,
                cap: BigInt(terms.cap),
                floor: BigInt(terms.floor),
                schedule: terms.schedule.map((step) => ({ completeness: step.completeness, payout: BigInt(step.payout) })),
                acceptS: terms.acceptS,
                deliverS: terms.deliverS,
                disputeS: terms.disputeS,
                jobId: hexBytes(terms.jobId, 32, "jobId"),
            },
            quoteHash: hexBytes(json.quoteHash, 32, "quoteHash"),
            signature: hexBytes(json.signature, 64, "signature"),
        };
    }

    /** Encodes the terms as the contract's `QuoteTerms` struct: an ScMap with keys in sorted order. */
    static toScVal(terms: QuoteTerms): xdr.ScVal {
        // Encode each schedule step as a sorted map
        const schedule = xdr.ScVal.scvVec(
            terms.schedule.map((step) =>
                this.map({
                    completeness: nativeToScVal(step.completeness, { type: "u32" }),
                    payout: nativeToScVal(step.payout, { type: "i128" }),
                }),
            ),
        );

        // Encode the terms with the contract's field names
        return this.map({
            seller: nativeToScVal(terms.seller, { type: "address" }),
            asset: nativeToScVal(terms.asset, { type: "address" }),
            cap: nativeToScVal(terms.cap, { type: "i128" }),
            floor: nativeToScVal(terms.floor, { type: "i128" }),
            schedule,
            accept_s: nativeToScVal(terms.acceptS, { type: "u64" }),
            deliver_s: nativeToScVal(terms.deliverS, { type: "u64" }),
            dispute_s: nativeToScVal(terms.disputeS, { type: "u64" }),
            job_id: xdr.ScVal.scvBytes(terms.jobId),
        });
    }

    /** Returns the quote hash: `sha256` of the terms' XDR encoding, as the contract computes it. */
    static hash(terms: QuoteTerms): Buffer {
        return createHash("sha256").update(this.toScVal(terms).toXDR()).digest();
    }

    /** Hashes the terms and signs the hash with the seller's account key. */
    static sign(terms: QuoteTerms, seller: Keypair): SignedQuote {
        // Refuse a key that is not the quoted seller's
        if (seller.publicKey() !== terms.seller) {
            throw new Error("The signing key does not match the quoted seller");
        }

        // Hash the terms and sign the hash
        const quoteHash = this.hash(terms);
        return { terms, quoteHash, signature: Buffer.from(seller.sign(quoteHash)) };
    }

    /** Returns true when the signature is the quoted seller's over the hash of these terms. */
    static verify(quote: SignedQuote): boolean {
        // Recompute the hash and compare it with the one carried
        const quoteHash = this.hash(quote.terms);
        if (!quoteHash.equals(quote.quoteHash)) {
            return false;
        }

        // Check the signature against the seller's account key
        return Keypair.fromPublicKey(quote.terms.seller).verify(quoteHash, quote.signature);
    }

    /** Returns the schedule's payout at exactly `completeness`, or null when no step has it. */
    static payoutAt(schedule: PayoutStep[], completeness: number): bigint | null {
        return schedule.find((step) => step.completeness === completeness)?.payout ?? null;
    }

    /** Builds an ScMap from named values, sorting keys as the contract's struct encoding does. */
    private static map(fields: Record<string, xdr.ScVal>): xdr.ScVal {
        // Sort the keys and wrap each value in a symbol-keyed entry
        const entries = Object.keys(fields)
            .sort()
            .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key] }));

        return xdr.ScVal.scvMap(entries);
    }
}

/** Decodes a hex string of exactly `length` bytes. */
function hexBytes(hex: string, length: number, field: string): Buffer {
    // Reject anything that is not exactly the expected number of hex bytes
    if (!new RegExp(`^[0-9a-fA-F]{${length * 2}}$`).test(hex)) {
        throw new Error(`${field} must be ${length} bytes of hex`);
    }

    return Buffer.from(hex, "hex");
}
