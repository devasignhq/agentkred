// Webhook signatures: an HMAC-SHA256 over the timestamp and raw body, sent in the `AgentKred-Signature` header.

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "agentkred-signature";
export const EVENT_ID_HEADER = "agentkred-event-id";

export class Webhooks {
    /** Returns the signature header value `t=<unix seconds>,v1=<hex hmac>` for a body sent at `timestamp`. */
    static sign(secret: string, body: string, timestamp: number): string {
        return `t=${timestamp},v1=${this.mac(secret, body, timestamp)}`;
    }

    /**
     * Returns true when the header carries a valid signature of `body` made within the tolerance.
     * @param secret - The recipient's webhook secret
     * @param body - The raw request body, exactly as received
     * @param header - The `AgentKred-Signature` header value
     * @param now - The current unix time in seconds
     * @param toleranceS - How old a signature may be, in seconds
     */
    static verify(secret: string, body: string, header: string, now: number, toleranceS = 300): boolean {
        // Parse the timestamp and signature out of the header
        const parts = new Map(header.split(",").map((part) => part.split("=", 2) as [string, string]));
        const timestamp = Number(parts.get("t"));
        const signature = parts.get("v1");
        if (!Number.isInteger(timestamp) || !signature || Math.abs(now - timestamp) > toleranceS) {
            return false;
        }

        // Compare the expected signature in constant time
        const expected = Buffer.from(this.mac(secret, body, timestamp), "hex");
        const given = Buffer.from(signature, "hex");
        return expected.length === given.length && timingSafeEqual(expected, given);
    }

    /** Returns the hex HMAC-SHA256 of `timestamp.body`. */
    private static mac(secret: string, body: string, timestamp: number): string {
        return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    }
}
