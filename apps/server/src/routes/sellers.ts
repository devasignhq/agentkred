// Seller listing routes: signed registration and public reads.

import { Router } from "express";
import { SellerService } from "../services/sellerService.js";
import { listingBody, parse } from "../config/validation.js";

export const sellerRoutes = Router();

/** Registers or updates a listing signed by the pay-to key; a new seller gets its webhook secret once. */
sellerRoutes.post("/", async (req, res) => {
    // Validate the body and store the listing
    const signed = parse(listingBody, req.body);
    const result = await SellerService.register(signed, Math.floor(Date.now() / 1000));

    res.status(result.created ? 201 : 200).json(result);
});

/** Returns a seller's public listing. */
sellerRoutes.get("/:payTo", async (req, res) => {
    res.json(await SellerService.get(req.params.payTo));
});
