// Testnet run of the coordinator: rejected locks, an acknowledged and a disputed escrow, signed webhooks and a clean journal verify.

import { readFileSync } from "node:fs";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { Contract, Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { AuthEntries, AuthorizedCall, Listings, Manifests, Quotes, SignedQuote, Webhooks, sleep } from "@agentkred/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/config/db.js";
import { ChainIngestor } from "../../src/journal/chainIngestor.js";
import { JournalTools } from "../../src/journal/journalTools.js";
import { WebhookService } from "../../src/services/webhookService.js";
import { stellar } from "../../src/config/stellar.js";

const secrets = JSON.parse(readFileSync(process.env.DEMO_SECRETS ?? "../../examples/cli-demo/.demo/secrets.json", "utf8")) as Record<string, string>;
const buyer = Keypair.fromSecret(secrets.buyer);
const seller = Keypair.fromSecret(secrets.seller);
const anyone = Keypair.fromSecret(secrets.anyone);
const app = createApp();
const received: { body: string; signature: string }[] = [];
const created: string[] = [];
let receiver: Server;

/** Returns a fresh 1 USDC quote from the demo seller. */
function quote(overrides: Partial<SignedQuote["terms"]> = {}): SignedQuote {
    return Quotes.sign(
        {
            seller: seller.publicKey(),
            asset: stellar.usdcContractId,
            cap: 10_000_000n,
            floor: 2_000_000n,
            schedule: [
                { completeness: 0, payout: 2_000_000n },
                { completeness: 50, payout: 6_000_000n },
                { completeness: 100, payout: 10_000_000n },
            ],
            acceptS: 300,
            deliverS: 300,
            disputeS: 300,
            jobId: Buffer.from(Keypair.random().rawPublicKey()),
            ...overrides,
        },
        seller,
    );
}

/** Signs the buyer's lock of `signed`, valid for `ledgers` more ledgers. */
async function lockAuth(signed: SignedQuote, ledgers = 60, transfer = signed.terms.cap): Promise<string> {
    // Nest the cap's transfer into the escrow under the lock call
    const transferCall = AuthEntries.callOf(
        new Contract(stellar.usdcContractId).call(
            "transfer",
            nativeToScVal(buyer.publicKey(), { type: "address" }),
            nativeToScVal(stellar.contractId, { type: "address" }),
            nativeToScVal(transfer, { type: "i128" }),
        ),
    );
    const call: AuthorizedCall = { ...AuthEntries.callOf(stellar.escrow.lockCall(buyer.publicKey(), signed)), subCalls: [transferCall] };

    return sign(call, buyer, ledgers);
}

/** Signs a call tree for `signer`, valid for `ledgers` more ledgers. */
async function sign(call: AuthorizedCall, signer: Keypair, ledgers = 60): Promise<string> {
    const validUntil = (await stellar.chain.ledgerSequence()) + ledgers;
    return AuthEntries.toBase64(await AuthEntries.sign(call, signer, validUntil, stellar.chain.config.networkPassphrase));
}

/** Locks, accepts and delivers a fresh quote through the API and returns the escrow id. */
async function lockAcceptDeliver(): Promise<bigint> {
    // Lock the quote
    const signed = quote();
    const locked = await request(app).post("/escrows").send({ quote: Quotes.toJson(signed), auth: await lockAuth(signed) });
    expect(locked.status, JSON.stringify(locked.body)).toBe(201);
    const id = BigInt(locked.body.escrow.id);
    created.push(id.toString());

    // Accept as the seller
    const accepted = await request(app).post(`/escrows/${id}/accept`).send({ auth: await sign(AuthEntries.callOf(stellar.escrow.acceptCall(id)), seller) });
    expect(accepted.body.state, JSON.stringify(accepted.body)).toBe("Accepted");

    // Deliver a manifest as the seller
    const manifest = { escrowId: id.toString(), artifactSha256: "ab".repeat(32), evidenceUrl: "https://example.com/evidence" };
    const auth = await sign(AuthEntries.callOf(stellar.escrow.deliverCall(id, Manifests.hash(manifest))), seller);
    const delivered = await request(app).post(`/escrows/${id}/manifest`).send({ artifactSha256: manifest.artifactSha256, evidenceUrl: manifest.evidenceUrl, auth });
    expect(delivered.body.state, JSON.stringify(delivered.body)).toBe("Delivered");

    return id;
}

/** Settles an escrow from an unrelated account, outside the API, and returns the journal's view once it catches up. */
async function settleAsStranger(id: bigint) {
    const settled = await stellar.escrow.settle(anyone, id);
    await ChainIngestor.waitForLedger(settled.ledger);
    return (await request(app).get(`/escrows/${id}`)).body;
}

describe("coordinator on testnet", () => {
    beforeAll(async () => {
        // Start a webhook receiver for the seller
        receiver = createServer((req, res) => {
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
                received.push({ body, signature: String(req.headers["agentkred-signature"]) });
                res.writeHead(200).end();
            });
        });
        await new Promise<void>((resolve) => receiver.listen(0, resolve));
        const webhookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;

        // List the demo seller for 0.5 to 2 USDC
        const listing = { payTo: seller.publicKey(), name: "Demo seller", capMin: "5000000", capMax: "20000000", acceptS: 300, deliverS: 300, disputeS: 300, webhookUrl };
        const registered = await request(app).post("/sellers").send(Listings.sign(listing, seller, Math.floor(Date.now() / 1000)));
        expect([200, 201]).toContain(registered.status);
    });

    afterAll(async () => {
        receiver.close();
        await prisma.$disconnect();
    });

    it("rejects a forged quote, mismatched arguments, expired auth and an out-of-range cap", async () => {
        // Build one genuine quote and four bad requests from it
        const signed = quote();
        const tampered = Quotes.toJson(signed);
        tampered.terms.floor = "1000000";
        const big = quote({ cap: 50_000_000n, floor: 0n, schedule: [{ completeness: 0, payout: 0n }, { completeness: 100, payout: 50_000_000n }] });
        const cases: [object, string][] = [
            [{ quote: tampered, auth: await lockAuth(signed) }, "forged_quote"],
            [{ quote: Quotes.toJson(signed), auth: await lockAuth(signed, 60, 1n) }, "mismatched_arguments"],
            [{ quote: Quotes.toJson(signed), auth: await lockAuth(signed, 1) }, "auth_expired"],
            [{ quote: Quotes.toJson(big), auth: await lockAuth(big) }, "cap_out_of_range"],
        ];

        // Post each and expect its 4xx before any submission
        const before = await prisma.chainTransaction.count();
        for (const [body, code] of cases) {
            const response = await request(app).post("/escrows").send(body);
            expect([response.status, response.body.error?.code]).toEqual([422, code]);
        }
        expect(await prisma.chainTransaction.count()).toBe(before);
    }, 60_000);

    it("acknowledges a delivery and settles the full cap to the seller", async () => {
        // Run the job to delivery and acknowledge as the buyer
        const id = await lockAcceptDeliver();
        const acknowledged = await request(app).post(`/escrows/${id}/acknowledge`).send({ auth: await sign(AuthEntries.callOf(stellar.escrow.acknowledgeCall(id)), buyer) });
        expect(acknowledged.body.state, JSON.stringify(acknowledged.body)).toBe("Acknowledged");

        // Settle from a stranger and read the outcome from the journal
        const escrow = await settleAsStranger(id);
        expect(escrow).toMatchObject({ state: "Released", settlement: { outcome: "Acknowledged", payout: "10000000", remainder: "0" } });
    }, 240_000);

    it("disputes at 50% and settles the scheduled price", async () => {
        // Run the job to delivery and dispute as the buyer
        const id = await lockAcceptDeliver();
        const auth = await sign(AuthEntries.callOf(stellar.escrow.disputeCall(id, 50)), buyer);
        const disputed = await request(app).post(`/escrows/${id}/dispute`).send({ completeness: 50, note: "Half the pages are missing", auth });
        expect(disputed.body).toMatchObject({ state: "Disputed", completeness: 50, dispute: { note: "Half the pages are missing" } });

        // Settle from a stranger and read the split
        const escrow = await settleAsStranger(id);
        expect(escrow).toMatchObject({ state: "Released", settlement: { outcome: "Disputed", payout: "6000000", remainder: "4000000" } });
    }, 240_000);

    it("delivers every transition to the seller's webhook, signed with its secret", async () => {
        // Dispatch until the queue is empty
        while ((await WebhookService.dispatchDue()) > 0) {
            await sleep(100);
        }

        // Check every body verifies
        const { webhookSecret } = await prisma.seller.findUniqueOrThrow({ where: { payTo: seller.publicKey() } });
        const now = Math.floor(Date.now() / 1000);
        expect(received.every(({ body, signature }) => Webhooks.verify(webhookSecret, body, signature, now))).toBe(true);

        // Check this run's escrows sent every lifecycle type
        const ours = received.map(({ body }) => JSON.parse(body)).filter((event) => created.includes(event.escrowId));
        const types = new Set(ours.map((event) => event.type));
        expect([...types].sort()).toEqual(["escrow.accepted", "escrow.acknowledged", "escrow.delivered", "escrow.disputed", "escrow.locked", "escrow.settled"]);
    }, 60_000);

    it("rebuilds the journal and verifies it against the chain with zero divergence", async () => {
        await JournalTools.rebuild();

        const { escrows, divergences } = await JournalTools.verify();

        expect(escrows).toBeGreaterThan(0);
        expect(divergences).toEqual([]);
    }, 240_000);
});
