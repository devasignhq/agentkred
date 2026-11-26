// Escrow routes: lock, the seller's accept and manifest, the buyer's acknowledge and dispute, and reads.

import { Response, Router } from "express";
import { EscrowDetails, EscrowService, PendingCall } from "../services/escrowService.js";
import { authBody, disputeBody, escrowIdParam, lockBody, manifestBody, parse } from "../config/validation.js";

export const escrowRoutes = Router();

/** Sends a party call's answer: 200 with the escrow, or 202 when the journal has not caught up with the landed call. */
function respond(res: Response, result: EscrowDetails | PendingCall): void {
    res.status(EscrowService.isPending(result) ? 202 : 200).json(result);
}

/** Validates a buyer's lock of a signed quote and submits it. */
escrowRoutes.post("/", async (req, res) => {
    // Validate the body and lock the quote
    const body = parse(lockBody, req.body);
    const result = await EscrowService.lock(body.quote, body.auth, body.buyerWebhookUrl);

    res.status(result.escrow ? 201 : 202).json(result);
});

/** Returns an escrow's state, deadlines, manifest and transactions. */
escrowRoutes.get("/:id", async (req, res) => {
    res.json(await EscrowService.get(BigInt(parse(escrowIdParam, req.params.id))));
});

/** Submits the seller's acceptance. */
escrowRoutes.post("/:id/accept", async (req, res) => {
    // Validate the body and submit the accept
    const { auth } = parse(authBody, req.body);
    respond(res, await EscrowService.accept(BigInt(parse(escrowIdParam, req.params.id)), auth));
});

/** Stores the seller's manifest and submits the delivery with its hash. */
escrowRoutes.post("/:id/manifest", async (req, res) => {
    // Validate the body and submit the delivery
    const body = parse(manifestBody, req.body);
    respond(res, await EscrowService.deliver(BigInt(parse(escrowIdParam, req.params.id)), body.artifactSha256, body.evidenceUrl, body.auth));
});

/** Submits the buyer's acknowledgement. */
escrowRoutes.post("/:id/acknowledge", async (req, res) => {
    // Validate the body and submit the acknowledgement
    const { auth } = parse(authBody, req.body);
    respond(res, await EscrowService.acknowledge(BigInt(parse(escrowIdParam, req.params.id)), auth));
});

/** Submits the buyer's dispute and stores its evidence. */
escrowRoutes.post("/:id/dispute", async (req, res) => {
    // Validate the body and submit the dispute
    const body = parse(disputeBody, req.body);
    respond(res, await EscrowService.dispute(BigInt(parse(escrowIdParam, req.params.id)), body.completeness, body.evidenceUrl, body.note, body.auth));
});
