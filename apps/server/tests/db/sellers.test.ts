// Seller listing routes: signed registration, updates, replays and public reads.

import { Keypair } from "@stellar/stellar-sdk";
import { Listings, SellerListing } from "@agentkred/shared";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { resetDatabase } from "../support/fakeChain.js";

const app = createApp();

/** Returns the current unix time in seconds. */
const now = () => Math.floor(Date.now() / 1000);

/** Returns a listing for `payTo` covering 0.5 to 2 USDC. */
function listing(payTo: string, overrides: Partial<SellerListing> = {}): SellerListing {
    return { payTo, name: "Toy seller", capMin: "5000000", capMax: "20000000", acceptS: 60, deliverS: 600, disputeS: 300, webhookUrl: "https://seller.example/hooks", ...overrides };
}

describe("POST /sellers", () => {
    beforeEach(resetDatabase);

    it("registers a signed listing, returns its webhook secret once and serves it publicly", async () => {
        // Register a new seller
        const seller = Keypair.random();
        const created = await request(app).post("/sellers").send(Listings.sign(listing(seller.publicKey()), seller, now()));

        expect(created.status).toBe(201);
        expect(created.body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);

        // Read it back without the secret
        const read = await request(app).get(`/sellers/${seller.publicKey()}`);
        expect(read.status).toBe(200);
        expect(read.body).toEqual(listing(seller.publicKey()));
    });

    it("updates a listing with a newer signature and refuses a replay", async () => {
        // Register, then update with a later signature
        const seller = Keypair.random();
        const first = Listings.sign(listing(seller.publicKey()), seller, now() - 10);
        await request(app).post("/sellers").send(first);
        const updated = await request(app).post("/sellers").send(Listings.sign(listing(seller.publicKey(), { name: "Renamed" }), seller, now()));

        expect(updated.status).toBe(200);
        expect(updated.body.webhookSecret).toBeUndefined();
        expect(updated.body.listing.name).toBe("Renamed");

        // Replay the first signature
        const replayed = await request(app).post("/sellers").send(first);
        expect(replayed.status).toBe(409);
        expect(replayed.body.error.code).toBe("replayed_listing");
    });

    it("rejects another key's signature, a stale signature, a bad cap range and a malformed body", async () => {
        const seller = Keypair.random();
        const impostor = Keypair.random();
        const forged = { ...Listings.sign(listing(impostor.publicKey()), impostor, now()), listing: listing(seller.publicKey()) };

        const cases: [object, number, string][] = [
            [forged, 401, "bad_signature"],
            [Listings.sign(listing(seller.publicKey()), seller, now() - 3_600), 401, "stale_signature"],
            [Listings.sign(listing(seller.publicKey(), { capMin: "30000000" }), seller, now()), 422, "invalid_listing"],
            [{ listing: { payTo: "nope" }, signedAt: now(), signature: "" }, 400, "invalid_request"],
        ];
        for (const [body, status, code] of cases) {
            const response = await request(app).post("/sellers").send(body);
            expect([response.status, response.body.error.code]).toEqual([status, code]);
        }
    });

    it("refuses a webhook URL without https or on a private or metadata address", async () => {
        const seller = Keypair.random();
        process.env.WEBHOOK_ALLOW_INSECURE = "false";

        // Post a listing for each disallowed webhook URL
        try {
            for (const webhookUrl of ["http://seller.example/hooks", "https://127.0.0.1/hooks", "https://169.254.169.254/latest", "https://localhost:8080/hooks"]) {
                const response = await request(app).post("/sellers").send(Listings.sign(listing(seller.publicKey(), { webhookUrl }), seller, now()));
                expect([webhookUrl, response.status, response.body.error.code]).toEqual([webhookUrl, 400, "invalid_request"]);
            }
        } finally {
            process.env.WEBHOOK_ALLOW_INSECURE = "true";
        }
    });

    it("answers 404 for an unknown seller", async () => {
        const response = await request(app).get(`/sellers/${Keypair.random().publicKey()}`);

        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe("seller_not_found");
    });
});
