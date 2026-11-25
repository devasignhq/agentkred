// Test fixtures: contract addresses, signed quotes and signed auth entries built without a network.

import { Contract, Keypair, Networks, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { AuthEntries, AuthorizedCall, EscrowClient, Quotes, SignedQuote, Submitter } from "@agentkred/shared";

export const ESCROW_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
export const USDC_ID = StrKey.encodeContract(Buffer.alloc(32, 2));
export const escrowClient = new EscrowClient(ESCROW_ID, {} as Submitter);

/** Returns a quote for a 1 USDC cap signed by `seller`, overriding any terms given. */
export function signedQuote(seller: Keypair, overrides: Partial<SignedQuote["terms"]> = {}): SignedQuote {
    return Quotes.sign(
        {
            seller: seller.publicKey(),
            asset: USDC_ID,
            cap: 10_000_000n,
            floor: 2_000_000n,
            schedule: [
                { completeness: 0, payout: 2_000_000n },
                { completeness: 50, payout: 6_000_000n },
                { completeness: 100, payout: 10_000_000n },
            ],
            acceptS: 60,
            deliverS: 600,
            disputeS: 300,
            jobId: Buffer.alloc(32, 7),
            ...overrides,
        },
        seller,
    );
}

/** Returns the call tree a buyer signs to lock `quote`: the lock with the cap's transfer beneath it. */
export function lockCall(buyer: string, quote: SignedQuote, transferAmount = quote.terms.cap): AuthorizedCall {
    // Build the cap's transfer into the escrow contract
    const transfer = AuthEntries.callOf(
        new Contract(USDC_ID).call("transfer", nativeToScVal(buyer, { type: "address" }), nativeToScVal(ESCROW_ID, { type: "address" }), nativeToScVal(transferAmount, { type: "i128" })),
    );

    return { ...AuthEntries.callOf(escrowClient.lockCall(buyer, quote)), subCalls: [transfer] };
}

/** Signs a call tree as base64 XDR, valid until `validUntil`. */
export async function signAuth(call: AuthorizedCall, signer: Keypair, validUntil = 1_000): Promise<string> {
    return AuthEntries.toBase64(await AuthEntries.sign(call, signer, validUntil, Networks.TESTNET));
}

/** Signs an unauthorized contract call operation as base64 XDR. */
export async function signOperation(operation: xdr.Operation, signer: Keypair, validUntil = 1_000): Promise<string> {
    return signAuth(AuthEntries.callOf(operation), signer, validUntil);
}
