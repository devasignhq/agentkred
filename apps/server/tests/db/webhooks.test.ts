// Webhook delivery to a local HTTP receiver: signed bodies, retries with backoff, and giving up after 24 hours.

import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { EVENT_ID_HEADER, SIGNATURE_HEADER, Webhooks } from "@agentkred/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/db.js";
import { WebhookService } from "../../src/services/webhookService.js";
import { resetDatabase } from "../support/fakeChain.js";

const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
let status = 200;
let server: Server;
let url: string;

/** Queues a seller delivery for escrow 1 at `url`, created at `createdAt`. */
async function queue(createdAt = new Date()): Promise<void> {
    await prisma.seller.create({
        data: { payTo: "GSELLER", name: "S", capMin: 1n, capMax: 2n, acceptS: 1, deliverS: 1, disputeS: 1, webhookSecret: "seller-secret", signedAt: 1, signature: "" },
    });
    await prisma.webhookDelivery.create({
        data: { eventId: "e1", recipient: "seller", url, escrowId: 1n, quoteHash: "q", seller: "GSELLER", type: "escrow.locked", body: '{"id":"e1"}', createdAt, nextAttemptAt: createdAt },
    });
}

describe("WebhookService.dispatchDue", () => {
    beforeAll(async () => {
        // Start a receiver that records requests and answers with `status`
        server = createServer((req, res) => {
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
                received.push({ headers: req.headers, body });
                res.writeHead(status).end();
            });
        });
        await new Promise<void>((resolve) => server.listen(0, resolve));
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
    });

    afterAll(() => {
        server.close();
    });

    beforeEach(async () => {
        await resetDatabase();
        received.length = 0;
        status = 200;
    });

    it("delivers a body signed with the recipient's secret", async () => {
        await queue();

        expect(await WebhookService.dispatchDue()).toBe(1);

        const [request] = received;
        expect(request.headers[EVENT_ID_HEADER]).toBe("e1");
        expect(Webhooks.verify("seller-secret", request.body, String(request.headers[SIGNATURE_HEADER]), Math.floor(Date.now() / 1000))).toBe(true);
        expect(await prisma.webhookDelivery.findFirst()).toMatchObject({ status: "Delivered", attempts: 1, lastStatusCode: 200 });
    });

    it("schedules a retry after a failure and does not send again before it is due", async () => {
        // Fail the first attempt
        status = 500;
        await queue();
        const now = new Date();
        await WebhookService.dispatchDue(now);

        const delivery = await prisma.webhookDelivery.findFirstOrThrow();
        expect(delivery).toMatchObject({ status: "Pending", attempts: 1, lastStatusCode: 500, lastError: "HTTP 500" });
        expect(delivery.nextAttemptAt.getTime() - now.getTime()).toBe(WebhookService.retryDelayMs(1));

        // Dispatch again before the retry is due
        expect(await WebhookService.dispatchDue(now)).toBe(0);
    });

    it("gives up once the next retry would fall outside 24 hours", async () => {
        status = 503;
        await queue(new Date(Date.now() - 24 * 60 * 60 * 1000 + 1_000));

        await WebhookService.dispatchDue();

        expect(await prisma.webhookDelivery.findFirst()).toMatchObject({ status: "Failed", attempts: 1 });
    });

    it("fails without sending when the recipient has no secret", async () => {
        // Queue a buyer delivery whose quote row does not exist
        await prisma.webhookDelivery.create({
            data: { eventId: "e1", recipient: "buyer", url, escrowId: 1n, quoteHash: "missing", seller: "GSELLER", type: "escrow.locked", body: '{"id":"e1"}' },
        });

        expect(await WebhookService.dispatchDue()).toBe(1);

        expect(received).toHaveLength(0);
        expect(await prisma.webhookDelivery.findFirst()).toMatchObject({ status: "Failed", attempts: 1, lastError: "Recipient has no webhook secret" });
    });

    it("refuses to send to a private address when insecure webhooks are off", async () => {
        await queue();
        process.env.WEBHOOK_ALLOW_INSECURE = "false";

        // Dispatch the delivery to the local receiver
        try {
            expect(await WebhookService.dispatchDue()).toBe(1);
        } finally {
            process.env.WEBHOOK_ALLOW_INSECURE = "true";
        }

        expect(received).toHaveLength(0);
        expect(await prisma.webhookDelivery.findFirst()).toMatchObject({ status: "Pending", attempts: 1, lastError: "Webhook URL must use https" });
    });

    it("doubles the retry delay up to an hour", () => {
        expect([1, 2, 3, 8, 20].map((attempt) => WebhookService.retryDelayMs(attempt))).toEqual([30_000, 60_000, 120_000, 3_600_000, 3_600_000]);
    });
});
