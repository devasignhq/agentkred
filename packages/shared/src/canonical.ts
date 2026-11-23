// Canonical JSON: sorted keys and no whitespace, so the same value always hashes and signs the same way.

import { createHash } from "node:crypto";

export class Canonical {
    /** Serializes `value` as JSON with object keys sorted at every level. */
    static json(value: unknown): string {
        return JSON.stringify(this.sortKeys(value));
    }

    /** Returns `sha256(domain + "\n" + canonical JSON of value)`. */
    static hash(domain: string, value: unknown): Buffer {
        return createHash("sha256").update(`${domain}\n${this.json(value)}`).digest();
    }

    /** Returns a copy of `value` whose objects list their keys in sorted order. */
    private static sortKeys(value: unknown): unknown {
        // Recurse into arrays element by element
        if (Array.isArray(value)) {
            return value.map((item) => this.sortKeys(item));
        }

        // Rebuild plain objects with sorted keys, dropping undefined fields
        if (value !== null && typeof value === "object") {
            const sorted: Record<string, unknown> = {};
            for (const key of Object.keys(value).sort()) {
                const field = (value as Record<string, unknown>)[key];
                if (field !== undefined) {
                    sorted[key] = this.sortKeys(field);
                }
            }
            return sorted;
        }

        return value;
    }
}
