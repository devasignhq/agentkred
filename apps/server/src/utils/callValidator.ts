// Checks a buyer's or seller's signed auth entry for one escrow call before AgentKred submits it.

import { xdr } from "@stellar/stellar-sdk";
import { AuthEntries } from "@agentkred/shared";
import { ApiError } from "../config/errors.js";
import { AUTH_MARGIN_LEDGERS } from "./lockValidator.js";

export class CallValidator {
    /**
     * Validates that an auth entry is `signer`'s authorization of exactly `expected`, throwing a 4xx otherwise.
     * @param auth - The signed auth entry as base64 XDR
     * @param expected - The unauthorized contract call the entry must cover
     * @param signer - The escrow party who must have signed it
     * @param currentLedger - The latest ledger sequence
     * @returns The decoded auth entry
     */
    static validate(auth: string, expected: xdr.Operation, signer: string, currentLedger: number): xdr.SorobanAuthorizationEntry {
        // Decode the entry
        let entry: xdr.SorobanAuthorizationEntry;
        try {
            entry = AuthEntries.fromBase64(auth);
        } catch {
            throw new ApiError(400, "malformed_auth", "The auth entry is not valid base64 XDR");
        }

        // Require the escrow party's signature
        const view = AuthEntries.describe(entry);
        if (!view || view.signer !== signer) {
            throw new ApiError(403, "wrong_signer", `The auth entry must be signed by ${signer}`);
        }

        // Require exactly the expected call and nothing beneath it
        if (!AuthEntries.sameCall(view.call, AuthEntries.callOf(expected))) {
            throw new ApiError(422, "mismatched_arguments", "The auth entry does not authorize this call");
        }

        // Require the signature to outlive submission
        if (view.expirationLedger < currentLedger + AUTH_MARGIN_LEDGERS) {
            throw new ApiError(422, "auth_expired", `The auth entry expires at ledger ${view.expirationLedger}, too close to the current ledger ${currentLedger}`);
        }

        return entry;
    }
}
