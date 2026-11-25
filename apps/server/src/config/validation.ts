// Request body schemas for the API, and parsing that turns schema failures into 400 errors.

import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import { ApiError } from "./errors.js";

const MAX_CLOCK_S = 30 * 24 * 60 * 60;
const stroops = z.string().regex(/^\d+$/, "must be a whole number of stroops as a string");
const clock = z.int().min(1).max(MAX_CLOCK_S);
const account = z.string().refine((value) => StrKey.isValidEd25519PublicKey(value), "must be a G... account address");
const httpUrl = z.url({ protocol: /^https?$/ });
const authEntry = z.string().min(1).max(20_000);

export const listingBody = z.object({
    listing: z.object({
        payTo: account,
        name: z.string().min(1).max(100),
        capMin: stroops,
        capMax: stroops,
        acceptS: clock,
        deliverS: clock,
        disputeS: clock,
        webhookUrl: httpUrl.nullable(),
    }),
    signedAt: z.int(),
    signature: z.string(),
});

export const quoteJson = z.object({
    terms: z.object({
        seller: z.string(),
        asset: z.string(),
        cap: stroops,
        floor: stroops,
        schedule: z.array(z.object({ completeness: z.int().min(0).max(100), payout: stroops })).min(1).max(101),
        acceptS: clock,
        deliverS: clock,
        disputeS: clock,
        jobId: z.string(),
    }),
    quoteHash: z.string(),
    signature: z.string(),
});

export const lockBody = z.object({
    quote: quoteJson,
    auth: authEntry,
    buyerWebhookUrl: httpUrl.optional(),
});

export const authBody = z.object({ auth: authEntry });

export const manifestBody = z.object({
    artifactSha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex sha256"),
    evidenceUrl: httpUrl.nullable().default(null),
    auth: authEntry,
});

export const disputeBody = z.object({
    completeness: z.int().min(0).max(99),
    evidenceUrl: httpUrl.nullable().default(null),
    note: z.string().max(2_000).nullable().default(null),
    auth: authEntry,
});

export const escrowIdParam = z.string().regex(/^\d{1,20}$/, "must be an escrow id");

/** Parses `value` against `schema`, throwing a 400 that lists every problem. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
    // Validate and collect each issue as path: message
    const result = schema.safeParse(value);
    if (!result.success) {
        const problems = result.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`);
        throw new ApiError(400, "invalid_request", problems.join("; "));
    }

    return result.data;
}
