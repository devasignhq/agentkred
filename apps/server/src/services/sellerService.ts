// Seller listings: registration and updates signed by the pay-to key, and public reads.

import { randomBytes } from "node:crypto";
import { Listings, SellerListing, SignedListing } from "@agentkred/shared";
import { prisma } from "../config/db.js";
import { ApiError } from "../config/errors.js";
import { Seller } from "../generated/prisma/client.js";

/** How far a listing's signing time may be from the server's clock, in seconds. */
export const LISTING_TOLERANCE_S = 300;

const MAX_CAP = 2n ** 63n - 1n;

export class SellerService {
    /**
     * Registers or updates a listing signed by its pay-to account's key.
     * @param signed - The listing, its signing time and the pay-to key's signature
     * @param now - The current unix time in seconds
     * @returns The stored listing, whether it is new, and the webhook secret on first registration
     */
    static async register(signed: SignedListing, now: number): Promise<{ listing: SellerListing; created: boolean; webhookSecret?: string }> {
        // Check the amounts are a positive range that fits the journal
        const { listing } = signed;
        const capMin = BigInt(listing.capMin);
        const capMax = BigInt(listing.capMax);
        if (capMin <= 0n || capMin > capMax || capMax > MAX_CAP) {
            throw new ApiError(422, "invalid_listing", "The cap range must satisfy 0 < capMin <= capMax < 2^63");
        }

        // Require a fresh signature from the pay-to key
        if (!Listings.verify(signed)) {
            throw new ApiError(401, "bad_signature", "The listing is not signed by its pay-to account");
        }
        if (Math.abs(now - signed.signedAt) > LISTING_TOLERANCE_S) {
            throw new ApiError(401, "stale_signature", `The listing must be signed within ${LISTING_TOLERANCE_S}s of now`);
        }

        // Refuse a replay of this listing or of an older one
        const existing = await prisma.seller.findUnique({ where: { payTo: listing.payTo } });
        if (existing && signed.signedAt <= existing.signedAt) {
            throw new ApiError(409, "replayed_listing", "A listing signed at the same time or later is already stored");
        }

        // Store the listing, generating a webhook secret only for a new seller
        const fields = {
            name: listing.name,
            capMin,
            capMax,
            acceptS: listing.acceptS,
            deliverS: listing.deliverS,
            disputeS: listing.disputeS,
            webhookUrl: listing.webhookUrl,
            signedAt: signed.signedAt,
            signature: signed.signature,
        };
        if (existing) {
            const updated = await prisma.seller.update({ where: { payTo: listing.payTo }, data: fields });
            return { listing: this.toListing(updated), created: false };
        }
        const webhookSecret = randomBytes(32).toString("hex");
        const created = await prisma.seller.create({ data: { payTo: listing.payTo, webhookSecret, ...fields } });

        return { listing: this.toListing(created), created: true, webhookSecret };
    }

    /** Returns a seller's public listing, or throws a 404. */
    static async get(payTo: string): Promise<SellerListing> {
        // Load the listing
        const seller = await prisma.seller.findUnique({ where: { payTo } });
        if (!seller) {
            throw new ApiError(404, "seller_not_found", `No listing for ${payTo}`);
        }

        return this.toListing(seller);
    }

    /** Converts a stored seller into its public listing, without the webhook secret. */
    static toListing(seller: Seller): SellerListing {
        return {
            payTo: seller.payTo,
            name: seller.name,
            capMin: seller.capMin.toString(),
            capMax: seller.capMax.toString(),
            acceptS: seller.acceptS,
            deliverS: seller.deliverS,
            disputeS: seller.disputeS,
            webhookUrl: seller.webhookUrl,
        };
    }
}
