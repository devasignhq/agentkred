// Seller listings: the terms a seller registers with AgentKred, signed by its pay-to account's key.

import { Keypair } from "@stellar/stellar-sdk";
import { Canonical } from "./canonical.js";

const LISTING_DOMAIN = "agentkred.listing.v1";

/** A seller's listing. Amounts are decimal stroop strings and clocks are seconds. */
export interface SellerListing {
    payTo: string;
    name: string;
    capMin: string;
    capMax: string;
    acceptS: number;
    deliverS: number;
    disputeS: number;
    webhookUrl: string | null;
}

/** A listing with the time it was signed and the pay-to key's signature, as sent to AgentKred. */
export interface SignedListing {
    listing: SellerListing;
    signedAt: number;
    signature: string;
}

export class Listings {
    /** Returns the 32-byte message a listing signature covers. */
    static message(listing: SellerListing, signedAt: number): Buffer {
        return Canonical.hash(LISTING_DOMAIN, { listing, signedAt });
    }

    /** Signs a listing with its pay-to account's key at `signedAt` unix seconds. */
    static sign(listing: SellerListing, payTo: Keypair, signedAt: number): SignedListing {
        // Refuse a key that is not the listing's pay-to account
        if (payTo.publicKey() !== listing.payTo) {
            throw new Error("The signing key does not match the listing's pay-to account");
        }

        // Sign the listing message
        const signature = Buffer.from(payTo.sign(this.message(listing, signedAt))).toString("hex");
        return { listing, signedAt, signature };
    }

    /** Returns true when the signature is the pay-to account's over this listing and time. */
    static verify(signed: SignedListing): boolean {
        // Decode the pay-to key and signature, treating malformed input as invalid
        try {
            const key = Keypair.fromPublicKey(signed.listing.payTo);
            return key.verify(this.message(signed.listing, signed.signedAt), Buffer.from(signed.signature, "hex"));
        } catch {
            return false;
        }
    }
}
