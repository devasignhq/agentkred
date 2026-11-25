// Signed webhooks for escrow transitions: queued from the journal, delivered with retries for 24 hours.

import { EVENT_ID_HEADER, SIGNATURE_HEADER, Webhooks } from "@agentkred/shared";
import { prisma, Tx } from "../config/db.js";
import { EscrowState, WebhookDelivery } from "../generated/prisma/client.js";
import { TransitionRow } from "../journal/escrowProjector.js";

/** The webhook event type sent for each escrow state. */
export const WEBHOOK_TYPES: Record<EscrowState, string> = {
    Locked: "escrow.locked",
    Accepted: "escrow.accepted",
    Delivered: "escrow.delivered",
    Acknowledged: "escrow.acknowledged",
    Disputed: "escrow.disputed",
    Released: "escrow.settled",
    Refunded: "escrow.refunded",
};

const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const FIRST_RETRY_MS = 30 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;
const CLAIM_MS = 60 * 1000;
const TIMEOUT_MS = 10 * 1000;

export class WebhookService {
    /** Queues a transition's webhook for the seller and, when it gave one at lock, the buyer. */
    static async enqueue(tx: Tx, transition: TransitionRow): Promise<void> {
        // Find the escrow, its seller's listing and the quote it was locked with
        const escrow = await tx.escrow.findUnique({ where: { id: transition.escrowId } });
        if (!escrow) {
            return;
        }
        const listing = await tx.seller.findUnique({ where: { payTo: escrow.seller } });
        const quote = await tx.quote.findUnique({ where: { quoteHash: escrow.quoteHash } });

        // Build the event body every recipient receives
        const type = WEBHOOK_TYPES[transition.state];
        const body = JSON.stringify({
            id: transition.eventId,
            type,
            escrowId: escrow.id.toString(),
            ledger: transition.ledger,
            txHash: transition.txHash,
            occurredAt: transition.at,
            data: transition.data,
        });

        // Collect the recipients that registered a webhook
        const recipients: { recipient: string; url: string }[] = [];
        if (listing?.webhookUrl) {
            recipients.push({ recipient: "seller", url: listing.webhookUrl });
        }
        if (quote?.buyerWebhookUrl && quote.buyer === escrow.buyer) {
            recipients.push({ recipient: "buyer", url: quote.buyerWebhookUrl });
        }

        // Queue one delivery per recipient, once per event
        await tx.webhookDelivery.createMany({
            data: recipients.map(({ recipient, url }) => ({
                eventId: transition.eventId,
                recipient,
                url,
                escrowId: escrow.id,
                quoteHash: escrow.quoteHash,
                seller: escrow.seller,
                type,
                body,
            })),
            skipDuplicates: true,
        });
    }

    /**
     * Sends every queued delivery that is due, claiming each so concurrent dispatchers skip it.
     * @returns The number of deliveries attempted
     */
    static async dispatchDue(now = new Date(), limit = 20): Promise<number> {
        // Load the oldest due deliveries
        const due = await prisma.webhookDelivery.findMany({
            where: { status: "Pending", nextAttemptAt: { lte: now } },
            orderBy: { id: "asc" },
            take: limit,
        });

        let attempted = 0;
        for (const delivery of due) {
            // Claim the delivery, skipping it when another dispatcher got there first
            const claimed = await prisma.webhookDelivery.updateMany({
                where: { id: delivery.id, status: "Pending", nextAttemptAt: delivery.nextAttemptAt },
                data: { nextAttemptAt: new Date(now.getTime() + CLAIM_MS) },
            });
            if (claimed.count === 0) {
                continue;
            }

            // Send it and record the outcome
            await this.deliver(delivery, now);
            attempted++;
        }

        return attempted;
    }

    /** Returns the delay before retry number `attempts`, doubling from 30 seconds up to an hour. */
    static retryDelayMs(attempts: number): number {
        return Math.min(FIRST_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS);
    }

    /**
     * Posts one signed delivery and records whether it succeeded, will be retried or has given up.
     * A delivery whose recipient has no secret fails at once, since an unsigned webhook could be forged.
     */
    private static async deliver(delivery: WebhookDelivery, now: Date): Promise<void> {
        // Fail the delivery without sending when the recipient has no secret
        const attempts = delivery.attempts + 1;
        const secret = await this.secretFor(delivery);
        if (!secret) {
            await prisma.webhookDelivery.update({
                where: { id: delivery.id },
                data: { status: "Failed", attempts, lastStatusCode: null, lastError: "Recipient has no webhook secret" },
            });
            return;
        }

        // Sign the body with the recipient's secret
        const headers = {
            "content-type": "application/json",
            [SIGNATURE_HEADER]: Webhooks.sign(secret, delivery.body, Math.floor(now.getTime() / 1000)),
            [EVENT_ID_HEADER]: delivery.eventId,
        };

        // Post it and capture the status or the network error
        let statusCode: number | null = null;
        let error: string | null = null;
        try {
            const response = await fetch(delivery.url, { method: "POST", headers, body: delivery.body, signal: AbortSignal.timeout(TIMEOUT_MS) });
            statusCode = response.status;
            if (!response.ok) {
                error = `HTTP ${response.status}`;
            }
        } catch (caught) {
            error = (caught as Error).message;
        }

        // Mark a 2xx delivered
        if (!error) {
            await prisma.webhookDelivery.update({
                where: { id: delivery.id },
                data: { status: "Delivered", attempts, lastStatusCode: statusCode, lastError: null, deliveredAt: now },
            });
            return;
        }

        // Schedule a retry, or give up once the next one would fall outside the retry window
        const nextAttemptAt = new Date(now.getTime() + this.retryDelayMs(attempts));
        const expired = nextAttemptAt.getTime() - delivery.createdAt.getTime() > RETRY_WINDOW_MS;
        await prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: { status: expired ? "Failed" : "Pending", attempts, lastStatusCode: statusCode, lastError: error, nextAttemptAt },
        });
    }

    /** Returns the webhook secret of the delivery's recipient. */
    private static async secretFor(delivery: WebhookDelivery): Promise<string | null> {
        // Read the seller's listing secret or the buyer's per-quote secret
        if (delivery.recipient === "seller") {
            return (await prisma.seller.findUnique({ where: { payTo: delivery.seller } }))?.webhookSecret ?? null;
        }

        return (await prisma.quote.findUnique({ where: { quoteHash: delivery.quoteHash } }))?.buyerWebhookSecret ?? null;
    }
}
