// Checks a lock request before AgentKred pays to submit it: the quote, the seller's listing and the buyer's auth entry.

import { Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { AuthEntries, AuthorizedCall, EscrowClient, QuoteJson, Quotes, SignedQuote } from "@agentkred/shared";
import { ApiError } from "../config/errors.js";
import { Seller } from "../generated/prisma/client.js";

/** Ledgers an auth entry must stay valid for beyond the current one, to survive submission. */
export const AUTH_MARGIN_LEDGERS = 3;

export interface LockContext {
    listing: Pick<Seller, "capMin" | "capMax"> | null;
    currentLedger: number;
    quoteUsed: boolean;
    escrow: EscrowClient;
    usdcContractId: string;
}

export interface ValidLock {
    quote: SignedQuote;
    entry: xdr.SorobanAuthorizationEntry;
    buyer: string;
}

export class LockValidator {
    /**
     * Validates a lock request, throwing a 4xx `ApiError` on the first check that fails.
     * @param quoteJson - The seller-signed quote the buyer is locking
     * @param auth - The buyer's signed auth entry for `lock`, as base64 XDR
     * @param context - The seller's listing, the current ledger and the contract clients
     * @returns The parsed quote, the auth entry and the buyer's address
     */
    static validate(quoteJson: QuoteJson, auth: string, context: LockContext): ValidLock {
        // Parse the quote
        const quote = this.parseQuote(quoteJson);
        const { terms } = quote;

        // Require a listed seller whose key signed exactly these terms
        if (!context.listing) {
            throw new ApiError(422, "unknown_seller", `Seller ${terms.seller} has no listing`);
        }
        if (!Quotes.verify(quote)) {
            throw new ApiError(422, "forged_quote", "The quote's hash or signature does not match the seller's terms");
        }

        // Require USDC and a cap inside the listed range
        if (terms.asset !== context.usdcContractId) {
            throw new ApiError(422, "wrong_asset", `The quote must be paid in USDC (${context.usdcContractId})`);
        }
        if (terms.cap < context.listing.capMin || terms.cap > context.listing.capMax) {
            throw new ApiError(422, "cap_out_of_range", `The cap is outside the seller's listed range of ${context.listing.capMin} to ${context.listing.capMax}`);
        }

        // Refuse a quote that already opened an escrow
        if (context.quoteUsed) {
            throw new ApiError(409, "quote_already_locked", "This quote has already been locked");
        }

        // Parse the auth entry and read who signed which call
        const entry = this.parseAuth(auth);
        const view = AuthEntries.describe(entry);
        if (!view) {
            throw new ApiError(422, "mismatched_arguments", "The auth entry must be signed by an address and authorize only contract calls");
        }

        // Require exactly the lock of this quote and the cap's transfer into the escrow contract
        if (!AuthEntries.sameCall(view.call, this.expectedCall(view.signer, quote, context))) {
            throw new ApiError(422, "mismatched_arguments", "The auth entry does not authorize locking exactly this quote");
        }

        // Require the signature to outlive submission
        if (view.expirationLedger < context.currentLedger + AUTH_MARGIN_LEDGERS) {
            throw new ApiError(422, "auth_expired", `The auth entry expires at ledger ${view.expirationLedger}, too close to the current ledger ${context.currentLedger}`);
        }

        return { quote, entry, buyer: view.signer };
    }

    /** Returns the call tree a valid lock authorizes: `lock` with the USDC transfer beneath it. */
    private static expectedCall(buyer: string, quote: SignedQuote, context: LockContext): AuthorizedCall {
        // Build the transfer of the cap from the buyer to the escrow contract
        const transfer = AuthEntries.callOf(
            new Contract(context.usdcContractId).call(
                "transfer",
                nativeToScVal(buyer, { type: "address" }),
                nativeToScVal(context.escrow.contractId, { type: "address" }),
                nativeToScVal(quote.terms.cap, { type: "i128" }),
            ),
        );

        // Nest it under the lock call
        return { ...AuthEntries.callOf(context.escrow.lockCall(buyer, quote)), subCalls: [transfer] };
    }

    /** Parses the quote's wire form, throwing a 400 on malformed fields. */
    private static parseQuote(json: QuoteJson): SignedQuote {
        try {
            return Quotes.fromJson(json);
        } catch (error) {
            throw new ApiError(400, "malformed_quote", (error as Error).message);
        }
    }

    /** Parses a base64 auth entry, throwing a 400 when it does not decode. */
    private static parseAuth(auth: string): xdr.SorobanAuthorizationEntry {
        try {
            return AuthEntries.fromBase64(auth);
        } catch {
            throw new ApiError(400, "malformed_auth", "The auth entry is not valid base64 XDR");
        }
    }
}
