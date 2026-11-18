// Typed wrapper around the deployed escrow contract's calls, reads and terminal events.

import { Contract, Keypair, StrKey, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { PayoutStep, Quotes, SignedQuote } from "./quote.js";
import { Submitted, Submitter } from "./submitter.js";

export interface EscrowView {
    buyer: string;
    seller: string;
    asset: string;
    cap: bigint;
    floor: bigint;
    schedule: PayoutStep[];
    jobId: string;
    quoteHash: string;
    state: string;
    lockedAt: number;
    acceptBy: number;
    acceptedAt: number | null;
    deliverBy: number | null;
    deliveredAt: number | null;
    disputeBy: number | null;
    manifestHash: string | null;
    acknowledgedAt: number | null;
    disputedAt: number | null;
    completeness: number | null;
    closedAt: number | null;
}

export type TerminalEvent =
    | { kind: "settled"; outcome: "Acknowledged" | "Silent" | "Disputed"; completeness: number; payout: bigint; remainder: bigint }
    | { kind: "refunded"; reason: "NotAccepted" | "NotDelivered"; amount: bigint };

export interface Sponsor {
    channel: Keypair;
    fees: Keypair;
}

export const ESCROW_ERRORS: Record<number, string> = {
    1: "EscrowNotFound",
    2: "InvalidCap",
    3: "InvalidDuration",
    4: "SameParty",
    5: "WrongState",
    6: "DeliverDeadlinePassed",
    7: "DeliverDeadlineNotPassed",
    8: "DisputeWindowOpen",
    9: "DisputeWindowClosed",
    10: "QuoteHashMismatch",
    11: "InvalidSeller",
    12: "InvalidFloor",
    13: "InvalidSchedule",
    14: "CompletenessNotInSchedule",
    15: "AcceptDeadlinePassed",
    16: "AcceptDeadlineNotPassed",
    17: "PayoutOutOfRange",
};

export class EscrowClient {
    private readonly contract: Contract;

    /**
     * Binds the client to a deployed escrow contract.
     * @param contractId - The escrow contract address
     * @param submitter - Submits and simulates the contract calls
     * @param sponsor - AgentKred's channel and fee accounts for sponsored calls
     */
    constructor(readonly contractId: string, private readonly submitter: Submitter, private readonly sponsor: Sponsor) {
        this.contract = new Contract(contractId);
    }

    /**
     * Locks the quoted cap from the buyer, who signs only its auth entry; AgentKred pays the fee.
     * @param buyer - The buyer's keypair, used only to sign the lock's auth entry
     * @param quote - The seller-signed quote whose terms, hash and signature are passed to the contract
     * @returns The transaction hash and the new escrow id
     */
    async lock(buyer: Keypair, quote: SignedQuote): Promise<Submitted & { escrowId: bigint }> {
        // Build the lock call with the signed quote
        const operation = this.contract.call(
            "lock",
            nativeToScVal(buyer.publicKey(), { type: "address" }),
            Quotes.toScVal(quote.terms),
            xdr.ScVal.scvBytes(quote.quoteHash),
            xdr.ScVal.scvBytes(quote.signature),
        );

        // Submit through AgentKred's fee-bump and read back the escrow id
        const submitted = await this.submitter.sponsored(operation, [buyer], this.sponsor.channel, this.sponsor.fees);
        return { ...submitted, escrowId: BigInt(scValToNative(submitted.returnValue!)) };
    }

    /** Records the seller's acceptance of the job, with AgentKred paying the fee. */
    async accept(seller: Keypair, escrowId: bigint): Promise<Submitted> {
        return this.sponsored(seller, "accept", this.id(escrowId));
    }

    /** Records the seller's manifest hash, with AgentKred paying the fee. */
    async deliver(seller: Keypair, escrowId: bigint, manifestHash: Buffer): Promise<Submitted> {
        return this.sponsored(seller, "deliver", this.id(escrowId), xdr.ScVal.scvBytes(manifestHash));
    }

    /** Records the buyer's acknowledgement of a delivery, with AgentKred paying the fee. */
    async acknowledge(buyer: Keypair, escrowId: bigint): Promise<Submitted> {
        return this.sponsored(buyer, "acknowledge", this.id(escrowId));
    }

    /** Records the buyer's dispute at a quoted completeness percentage, with AgentKred paying the fee. */
    async dispute(buyer: Keypair, escrowId: bigint, completeness: number): Promise<Submitted> {
        return this.sponsored(buyer, "dispute", this.id(escrowId), nativeToScVal(completeness, { type: "u32" }));
    }

    /** Settles an acknowledged, disputed or silently closed escrow from any account, which pays its own fee. */
    async settle(caller: Keypair, escrowId: bigint): Promise<Submitted> {
        return this.submitter.direct(this.contract.call("settle", this.id(escrowId)), caller);
    }

    /** Refunds an unaccepted or undelivered escrow from any account, which pays its own fee. */
    async refund(caller: Keypair, escrowId: bigint): Promise<Submitted> {
        return this.submitter.direct(this.contract.call("refund", this.id(escrowId)), caller);
    }

    /** Reads an escrow's current state through simulation. */
    async get(escrowId: bigint, reader: string): Promise<EscrowView> {
        // Simulate get_escrow and convert the result
        const value = await this.submitter.read(this.contract.call("get_escrow", this.id(escrowId)), reader);
        const raw = scValToNative(value);

        // Map the contract struct into a view
        return {
            buyer: raw.buyer,
            seller: raw.seller,
            asset: raw.asset,
            cap: BigInt(raw.cap),
            floor: BigInt(raw.floor),
            schedule: raw.schedule.map((step: { completeness: number; payout: bigint }) => ({
                completeness: Number(step.completeness),
                payout: BigInt(step.payout),
            })),
            jobId: Buffer.from(raw.job_id).toString("hex"),
            quoteHash: Buffer.from(raw.quote_hash).toString("hex"),
            state: variantName(raw.state),
            lockedAt: Number(raw.locked_at),
            acceptBy: Number(raw.accept_by),
            acceptedAt: optionalNumber(raw.accepted_at),
            deliverBy: optionalNumber(raw.deliver_by),
            deliveredAt: optionalNumber(raw.delivered_at),
            disputeBy: optionalNumber(raw.dispute_by),
            manifestHash: raw.manifest_hash == null ? null : Buffer.from(raw.manifest_hash).toString("hex"),
            acknowledgedAt: optionalNumber(raw.acknowledged_at),
            disputedAt: optionalNumber(raw.disputed_at),
            completeness: optionalNumber(raw.completeness),
            closedAt: optionalNumber(raw.closed_at),
        };
    }

    /** Returns the settle or refund event this contract emitted in a submitted transaction. */
    terminalEvent(submitted: Submitted): TerminalEvent {
        for (const event of submitted.events) {
            // Skip events from other contracts, such as the token transfers
            const emitter = event.contractId?.toBytes();
            if (!emitter || StrKey.encodeContract(Buffer.from(emitter)) !== this.contractId) {
                continue;
            }

            // Decode the event name and its data map
            const body = event.body.v0;
            const name = scValToNative(body.topics[0]);
            const data = scValToNative(body.data);

            // Return the settlement or refund in a typed form
            if (name === "escrow_settled") {
                return {
                    kind: "settled",
                    outcome: variantName(data.outcome) as "Acknowledged" | "Silent" | "Disputed",
                    completeness: Number(data.completeness),
                    payout: BigInt(data.payout),
                    remainder: BigInt(data.remainder),
                };
            }
            if (name === "escrow_refunded") {
                return {
                    kind: "refunded",
                    reason: variantName(data.reason) as "NotAccepted" | "NotDelivered",
                    amount: BigInt(data.amount),
                };
            }
        }

        throw new Error(`Transaction ${submitted.hash} emitted no settle or refund event`);
    }

    /** Submits a party's call through AgentKred's fee-bump, signing only that party's auth entry. */
    private sponsored(signer: Keypair, method: string, ...args: xdr.ScVal[]): Promise<Submitted> {
        return this.submitter.sponsored(this.contract.call(method, ...args), [signer], this.sponsor.channel, this.sponsor.fees);
    }

    /** Encodes an escrow id as the contract's u64. */
    private id(escrowId: bigint): xdr.ScVal {
        return nativeToScVal(escrowId, { type: "u64" });
    }
}

/** Converts an optional contract integer into a number or null. */
function optionalNumber(value: unknown): number | null {
    return value == null ? null : Number(value);
}

/** Returns the name of a contract unit enum, which decodes as a one-element array. */
function variantName(value: unknown): string {
    return Array.isArray(value) ? String(value[0]) : String(value);
}
