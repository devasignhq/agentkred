// Webhook URL guard: blocked address ranges, the https rule, and a lookup that refuses hosts resolving to blocked addresses.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebhookUrls } from "../../src/utils/webhookUrls.js";

describe("WebhookUrls", () => {
    beforeEach(() => {
        process.env.WEBHOOK_ALLOW_INSECURE = "false";
    });

    afterEach(() => {
        process.env.WEBHOOK_ALLOW_INSECURE = "true";
    });

    it("blocks loopback, private, link-local, metadata and mapped addresses but not public ones", () => {
        const blocked = ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00:ec2::254", "fe80::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe"];
        const allowed = ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"];

        expect(blocked.filter((address) => !WebhookUrls.isBlockedAddress(address))).toEqual([]);
        expect(allowed.filter((address) => WebhookUrls.isBlockedAddress(address))).toEqual([]);
    });

    it("requires https and refuses localhost names and blocked IP literals", () => {
        expect(WebhookUrls.problem("https://seller.example/hooks")).toBeNull();
        expect(WebhookUrls.problem("http://seller.example/hooks")).toBe("must use https");
        expect(WebhookUrls.problem("https://localhost/hooks")).toBe("must not point at localhost");
        expect(WebhookUrls.problem("https://api.localhost./hooks")).toBe("must not point at localhost");
        expect(WebhookUrls.problem("https://169.254.169.254/latest/meta-data")).toBe("must not point at a private or reserved address");
        expect(WebhookUrls.problem("https://[::1]/hooks")).toBe("must not point at a private or reserved address");
    });

    it("allows plain http and local addresses only when insecure webhooks are enabled", () => {
        process.env.WEBHOOK_ALLOW_INSECURE = "true";

        expect(WebhookUrls.problem("http://127.0.0.1:8080/hooks")).toBeNull();
        expect(WebhookUrls.problem("ftp://seller.example/hooks")).toBe("must use http or https");
    });

    it("refuses a host whose DNS answer is a blocked address", async () => {
        // Resolve localhost through the guarded lookup
        const lookup = WebhookUrls.guardedLookup();
        const error = await new Promise<Error | null>((resolve) => lookup("localhost", {}, (caught) => resolve(caught)));

        expect(error?.message).toMatch(/blocked address/);
    });

    it("refuses to post to a blocked URL without connecting", async () => {
        await expect(WebhookUrls.post("https://127.0.0.1/hooks", {}, "{}", 1_000)).rejects.toThrow("Webhook URL must not point at a private or reserved address");
    });
});
