// Builders for the escrow contract's event data, as the fake chain emits them.

import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { SignedQuote } from "@agentkred/shared";
import { FakeChain } from "./fakeChain.js";

/** Encodes an address as a contract value. */
const address = (value: string) => nativeToScVal(value, { type: "address" });

/** Encodes a unit enum variant as the contract does. */
const variant = (name: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]);

/** Emits `escrow_locked` for `quote` locked by `buyer`. */
export function emitLocked(chain: FakeChain, escrowId: bigint, buyer: string, quote: SignedQuote): number {
    return chain.emit("escrow_locked", escrowId, {
        buyer: address(buyer),
        seller: address(quote.terms.seller),
        asset: address(quote.terms.asset),
        cap: nativeToScVal(quote.terms.cap, { type: "i128" }),
        floor: nativeToScVal(quote.terms.floor, { type: "i128" }),
        job_id: xdr.ScVal.scvBytes(quote.terms.jobId),
        quote_hash: xdr.ScVal.scvBytes(quote.quoteHash),
        accept_by: nativeToScVal(BigInt(chain.latestLedger * 5 + quote.terms.acceptS), { type: "u64" }),
    });
}

/** Emits `escrow_accepted` with a deliver-by. */
export function emitAccepted(chain: FakeChain, escrowId: bigint, deliverBy: number): number {
    return chain.emit("escrow_accepted", escrowId, { deliver_by: nativeToScVal(BigInt(deliverBy), { type: "u64" }) });
}

/** Emits `escrow_delivered` with a manifest hash and dispute-by. */
export function emitDelivered(chain: FakeChain, escrowId: bigint, manifestHash: Buffer, disputeBy: number): number {
    return chain.emit("escrow_delivered", escrowId, {
        manifest_hash: xdr.ScVal.scvBytes(manifestHash),
        dispute_by: nativeToScVal(BigInt(disputeBy), { type: "u64" }),
    });
}

/** Emits `escrow_refunded` returning `amount` to `buyer`. */
export function emitRefunded(chain: FakeChain, escrowId: bigint, buyer: string, amount: bigint): number {
    return chain.emit("escrow_refunded", escrowId, {
        buyer: address(buyer),
        reason: variant("NotAccepted"),
        amount: nativeToScVal(amount, { type: "i128" }),
    });
}

/** Emits `escrow_settled` with an outcome and split. */
export function emitSettled(chain: FakeChain, escrowId: bigint, buyer: string, seller: string, outcome: string, payout: bigint, remainder: bigint): number {
    return chain.emit("escrow_settled", escrowId, {
        buyer: address(buyer),
        seller: address(seller),
        outcome: variant(outcome),
        completeness: nativeToScVal(100, { type: "u32" }),
        payout: nativeToScVal(payout, { type: "i128" }),
        remainder: nativeToScVal(remainder, { type: "i128" }),
    });
}
