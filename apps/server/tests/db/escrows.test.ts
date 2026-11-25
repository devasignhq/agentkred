// Escrow routes over a fake chain: lock, accept, manifest and dispute are validated, submitted and read back from the journal.

import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { Listings, Manifests, Quotes, SimulationError } from "@agentkred/shared";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/config/db.js";
import { emitAccepted, emitDelivered, emitLocked } from "../support/events.js";
import { FakeChain, resetDatabase } from "../support/fakeChain.js";
import { escrowClient, lockCall, signAuth, signOperation, signedQuote } from "../support/fixtures.js";

const app = createApp();
const seller = Keypair.random();
const buyer = Keypair.random();
let chain: FakeChain;

/** Registers the test seller with a 0.5 to 2 USDC range and a webhook. */
async function registerSeller(): Promise<void> {
    const listing = { payTo: seller.publicKey(), name: "Toy", capMin: "5000000", capMax: "20000000", acceptS: 60, deliverS: 600, disputeS: 300, webhookUrl: "https://seller.example/hooks" };
    await request(app).post("/sellers").send(Listings.sign(listing, seller, Math.floor(Date.now() / 1000))).expect(201);
}

/** Locks a fresh quote through the API, with the fake chain emitting the lock, and returns the escrow id. */
async function lock(): Promise<bigint> {
    // Answer the submission with escrow id 1 and its lock event
    const quote = signedQuote(seller);
    chain.nextSubmit = () => ({ hash: "aa".repeat(32), ledger: emitLocked(chain, 1n, buyer.publicKey(), quote), returnValue: nativeToScVal(1n, { type: "u64" }), events: [] });

    // Post the quote with the buyer's auth
    const auth = await signAuth(lockCall(buyer.publicKey(), quote), buyer, 2_000);
    const response = await request(app).post("/escrows").send({ quote: Quotes.toJson(quote), auth, buyerWebhookUrl: "https://buyer.example/hooks" });
    expect(response.status).toBe(201);

    return BigInt(response.body.escrow.id);
}

describe("escrow routes", () => {
    beforeEach(async () => {
        await resetDatabase();
        chain = new FakeChain();
        chain.install();
        await registerSeller();
    });

    it("locks a valid quote and serves the escrow with its schedule", async () => {
        const id = await lock();

        // Read the escrow and the recorded submission
        const response = await request(app).get(`/escrows/${id}`);
        const submissions = await prisma.chainTransaction.findMany();

        expect(response.body).toMatchObject({ id: "1", state: "Locked", buyer: buyer.publicKey(), seller: seller.publicKey(), cap: "10000000" });
        expect(response.body.schedule).toHaveLength(3);
        expect(submissions).toMatchObject([{ kind: "lock", status: "Succeeded", escrowId: 1n, hash: "aa".repeat(32) }]);
    });

    it("queues the lock's webhook for the seller and the buyer", async () => {
        await lock();

        const deliveries = await prisma.webhookDelivery.findMany({ orderBy: { recipient: "asc" } });

        expect(deliveries.map((delivery) => [delivery.recipient, delivery.type, delivery.url])).toEqual([
            ["buyer", "escrow.locked", "https://buyer.example/hooks"],
            ["seller", "escrow.locked", "https://seller.example/hooks"],
        ]);
    });

    it("rejects a forged quote without submitting anything", async () => {
        // Raise the cap after the seller signed
        const quote = signedQuote(seller);
        const json = Quotes.toJson(quote);
        json.terms.cap = "15000000";
        const auth = await signAuth(lockCall(buyer.publicKey(), quote), buyer, 2_000);

        const response = await request(app).post("/escrows").send({ quote: json, auth });

        expect([response.status, response.body.error.code]).toEqual([422, "forged_quote"]);
        expect(chain.submitted).toHaveLength(0);
        expect(await prisma.chainTransaction.count()).toBe(0);
    });

    it("refuses to lock the same quote twice", async () => {
        // Lock once, then post the same quote again
        await lock();
        const quote = signedQuote(seller);
        const auth = await signAuth(lockCall(buyer.publicKey(), quote), buyer, 2_000);

        const response = await request(app).post("/escrows").send({ quote: Quotes.toJson(quote), auth });

        expect([response.status, response.body.error.code]).toEqual([409, "quote_already_locked"]);
    });

    it("accepts, then delivers a manifest whose hash the seller signed", async () => {
        const id = await lock();

        // Accept with the seller's auth
        chain.nextSubmit = () => ({ hash: "bb".repeat(32), ledger: emitAccepted(chain, id, 9_999), events: [] });
        const accepted = await request(app).post(`/escrows/${id}/accept`).send({ auth: await signOperation(escrowClient.acceptCall(id), seller, 2_000) });
        expect(accepted.body).toMatchObject({ state: "Accepted", deliverBy: 9_999 });

        // Deliver a manifest, signing deliver over its hash
        const manifest = { escrowId: id.toString(), artifactSha256: "cd".repeat(32), evidenceUrl: "https://seller.example/evidence" };
        const hash = Manifests.hash(manifest);
        chain.nextSubmit = () => ({ hash: "cc".repeat(32), ledger: emitDelivered(chain, id, hash, 10_500), events: [] });
        const auth = await signOperation(escrowClient.deliverCall(id, hash), seller, 2_000);
        const delivered = await request(app).post(`/escrows/${id}/manifest`).send({ artifactSha256: manifest.artifactSha256, evidenceUrl: manifest.evidenceUrl, auth });

        expect(delivered.body).toMatchObject({
            state: "Delivered",
            manifestHash: hash.toString("hex"),
            manifest: { artifactSha256: manifest.artifactSha256, evidenceUrl: manifest.evidenceUrl },
        });
    });

    it("rejects a manifest that differs from the one the seller signed, and a buyer signing the seller's call", async () => {
        const id = await lock();

        // Sign deliver over one artifact and post another
        const signedHash = Manifests.hash({ escrowId: id.toString(), artifactSha256: "cd".repeat(32), evidenceUrl: null });
        const auth = await signOperation(escrowClient.deliverCall(id, signedHash), seller, 2_000);
        const mismatched = await request(app).post(`/escrows/${id}/manifest`).send({ artifactSha256: "ef".repeat(32), auth });

        // Sign accept as the buyer
        const byBuyer = await request(app).post(`/escrows/${id}/accept`).send({ auth: await signOperation(escrowClient.acceptCall(id), buyer, 2_000) });

        expect([mismatched.status, mismatched.body.error.code]).toEqual([422, "mismatched_arguments"]);
        expect([byBuyer.status, byBuyer.body.error.code]).toEqual([403, "wrong_signer"]);
    });

    it("translates a contract error and records the failed submission", async () => {
        const id = await lock();

        // Fail the accept as the contract does past accept-by
        chain.nextSubmit = () => {
            throw new SimulationError("HostError: Error(Contract, #15)");
        };
        const response = await request(app).post(`/escrows/${id}/accept`).send({ auth: await signOperation(escrowClient.acceptCall(id), seller, 2_000) });

        expect([response.status, response.body.error.code]).toEqual([409, "accept_deadline_passed"]);
        expect(await prisma.chainTransaction.findFirst({ where: { kind: "accept" } })).toMatchObject({ status: "Failed" });
    });

    it("answers 404 for an unknown escrow and 400 for a malformed id", async () => {
        expect((await request(app).get("/escrows/77")).status).toBe(404);
        expect((await request(app).get("/escrows/abc")).status).toBe(400);
    });
});
