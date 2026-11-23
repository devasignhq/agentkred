// Canonical JSON, seller listing signatures, manifest hashes and webhook signatures.

import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { Canonical } from "../src/canonical.js";
import { Listings, SellerListing } from "../src/listing.js";
import { Manifests } from "../src/manifest.js";
import { Webhooks } from "../src/webhook.js";

/** Returns a listing for `payTo` with fixed terms. */
function listing(payTo: string): SellerListing {
    return { payTo, name: "Seller", capMin: "1000000", capMax: "50000000", acceptS: 60, deliverS: 600, disputeS: 300, webhookUrl: null };
}

describe("Canonical.json", () => {
    it("sorts keys at every level and drops undefined fields", () => {
        expect(Canonical.json({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[{"y":2,"z":1}]},"b":1}');
    });
});

describe("Listings", () => {
    it("verifies a listing signed by its pay-to key", () => {
        const seller = Keypair.random();
        const signed = Listings.sign(listing(seller.publicKey()), seller, 1_700_000_000);

        expect(Listings.verify(signed)).toBe(true);
    });

    it("rejects a changed listing, a changed time or another key's signature", () => {
        // Sign once and tamper with each part
        const seller = Keypair.random();
        const signed = Listings.sign(listing(seller.publicKey()), seller, 1_700_000_000);
        const other = Keypair.random();
        const forged = Listings.sign(listing(other.publicKey()), other, 1_700_000_000);

        expect(Listings.verify({ ...signed, listing: { ...signed.listing, capMax: "99000000" } })).toBe(false);
        expect(Listings.verify({ ...signed, signedAt: signed.signedAt + 1 })).toBe(false);
        expect(Listings.verify({ ...signed, signature: forged.signature })).toBe(false);
        expect(Listings.verify({ ...signed, signature: "zz" })).toBe(false);
    });

    it("refuses to sign with a key other than the pay-to account's", () => {
        expect(() => Listings.sign(listing(Keypair.random().publicKey()), Keypair.random(), 1)).toThrow("pay-to");
    });
});

describe("Manifests.hash", () => {
    it("is stable under key order and changes with any field", () => {
        const manifest = { escrowId: "7", artifactSha256: "ab".repeat(32), evidenceUrl: null };
        const reordered = { evidenceUrl: null, artifactSha256: "ab".repeat(32), escrowId: "7" };

        expect(Manifests.hash(manifest).equals(Manifests.hash(reordered))).toBe(true);
        expect(Manifests.hash({ ...manifest, escrowId: "8" }).equals(Manifests.hash(manifest))).toBe(false);
        expect(Manifests.hash(manifest)).toHaveLength(32);
    });
});

describe("Webhooks", () => {
    const body = '{"id":"1","type":"escrow.locked"}';

    it("verifies its own signature within the tolerance", () => {
        const header = Webhooks.sign("secret", body, 1_000);

        expect(header).toMatch(/^t=1000,v1=[0-9a-f]{64}$/);
        expect(Webhooks.verify("secret", body, header, 1_200)).toBe(true);
    });

    it("rejects another secret, a changed body, an old timestamp and a malformed header", () => {
        const header = Webhooks.sign("secret", body, 1_000);

        expect(Webhooks.verify("other", body, header, 1_000)).toBe(false);
        expect(Webhooks.verify("secret", body + " ", header, 1_000)).toBe(false);
        expect(Webhooks.verify("secret", body, header, 1_301)).toBe(false);
        expect(Webhooks.verify("secret", body, "v1=abc", 1_000)).toBe(false);
    });
});
