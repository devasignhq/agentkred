// The Express app: JSON body parsing, the seller and escrow routes, and JSON error responses.

import express, { NextFunction, Request, Response } from "express";
import { ApiError } from "./config/errors.js";
import { escrowRoutes } from "./routes/escrows.js";
import { sellerRoutes } from "./routes/sellers.js";

/** Builds the API app without starting a server. */
export function createApp(): express.Express {
    // Parse JSON bodies
    const app = express();
    app.use(express.json({ limit: "100kb" }));

    // Answer health checks and mount the routes
    app.get("/health", (_req, res) => {
        res.json({ ok: true });
    });
    app.use("/sellers", sellerRoutes);
    app.use("/escrows", escrowRoutes);

    // Answer unknown routes with a 404
    app.use((_req, _res, next) => {
        next(new ApiError(404, "not_found", "No such route"));
    });

    // Render API errors as JSON and hide anything unexpected behind a 500
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        if (error instanceof ApiError) {
            res.status(error.status).json({ error: { code: error.code, message: error.message } });
            return;
        }
        if (error instanceof SyntaxError && "body" in error) {
            res.status(400).json({ error: { code: "invalid_json", message: "The request body is not valid JSON" } });
            return;
        }
        console.error(error);
        res.status(500).json({ error: { code: "internal_error", message: "Something went wrong" } });
    });

    return app;
}
