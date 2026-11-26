// Webhook URL guard: https only, and never a loopback, private, link-local or metadata address.

import { LookupAddress, lookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, LookupFunction, isIP } from "node:net";
import { Env } from "../config/env.js";

/** Address ranges a webhook may never reach. */
const BLOCKED = new BlockList();

// Block the reserved IPv4 ranges
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
] as const) {
    BLOCKED.addSubnet(network, prefix, "ipv4");
}

// Block the reserved IPv6 ranges
for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
] as const) {
    BLOCKED.addSubnet(network, prefix, "ipv6");
}

export class WebhookUrls {
    /** Returns true when an IP address is loopback, private, link-local, metadata or otherwise not public. */
    static isBlockedAddress(address: string): boolean {
        // Treat anything that is not an IP address as blocked
        const family = isIP(address);
        if (family === 0) {
            return true;
        }

        // Check an IPv4-mapped IPv6 address as the IPv4 address it carries
        const mapped = family === 6 ? this.mappedIpv4(address) : null;
        if (mapped) {
            return BLOCKED.check(mapped, "ipv4");
        }

        return BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
    }

    /** Returns the IPv4 address inside an `::ffff:` mapped IPv6 address, in dotted or hex form, or null. */
    private static mappedIpv4(address: string): string | null {
        // Match the mapped prefix and read the dotted tail as is
        const tail = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(.+)$/i.exec(address)?.[1];
        if (!tail) {
            return null;
        }
        if (isIP(tail) === 4) {
            return tail;
        }

        // Convert a hex tail of two 16-bit groups into dotted form
        const groups = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
        if (!groups) {
            return null;
        }
        const [high, low] = [parseInt(groups[1], 16), parseInt(groups[2], 16)];

        return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }

    /** Returns why a webhook URL is not allowed, or null when it is, without resolving its host. */
    static problem(url: string): string | null {
        // Parse the URL
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return "must be a valid URL";
        }

        // Allow anything parseable in local development and tests
        if (Env.webhookAllowInsecure()) {
            return /^https?:$/.test(parsed.protocol) ? null : "must use http or https";
        }

        // Require https
        if (parsed.protocol !== "https:") {
            return "must use https";
        }

        // Refuse localhost names and IP literals in blocked ranges
        const host = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
        if (host === "localhost" || host.endsWith(".localhost")) {
            return "must not point at localhost";
        }
        if (isIP(host) !== 0 && this.isBlockedAddress(host)) {
            return "must not point at a private or reserved address";
        }

        return null;
    }

    /**
     * Posts a webhook body without following redirects, refusing any host that resolves to a blocked address.
     * Resolving inside the connection's own lookup closes the gap a DNS rebind would slip through.
     * @returns The response's status code
     */
    static post(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<number> {
        // Check the URL before opening a connection
        const problem = this.problem(url);
        if (problem) {
            return Promise.reject(new Error(`Webhook URL ${problem}`));
        }

        return new Promise((resolve, reject) => {
            // Send the request through the guarded lookup
            const send = url.startsWith("https:") ? httpsRequest : httpRequest;
            const req = send(url, { method: "POST", headers, lookup: this.guardedLookup(), timeout: timeoutMs }, (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode ?? 0));
                res.on("error", reject);
            });

            // Fail on a timeout or a network error
            req.on("timeout", () => req.destroy(new Error(`Timed out after ${timeoutMs}ms`)));
            req.on("error", reject);
            req.end(body);
        });
    }

    /** Returns a DNS lookup that fails when any resolved address is blocked. */
    static guardedLookup(): LookupFunction {
        return (hostname, options, callback) => {
            lookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
                // Pass resolution failures through
                if (error) {
                    callback(error, "", 0);
                    return;
                }

                // Refuse the host when any of its addresses is blocked
                const blocked = !Env.webhookAllowInsecure() && addresses.some(({ address }) => this.isBlockedAddress(address));
                if (blocked || addresses.length === 0) {
                    callback(new Error(`Webhook host ${hostname} resolves to a blocked address`), "", 0);
                    return;
                }

                // Answer in the form the caller asked for
                if (options.all) {
                    (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses);
                } else {
                    callback(null, addresses[0].address, addresses[0].family);
                }
            });
        };
    }
}
