// Typed wrapper around the deployed escrow contract's lock, deliver, settle, refund and get_escrow calls.

import { Contract, Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Config } from "./config.js";
import { Submitted, Submitter } from "./submitter.js";

export interface EscrowView {
    buyer: string;
    seller: string;
    cap: bigint;
    state: string;
    lockedAt: number;
    deliverBy: number;
    disputeBy: number | null;
    manifestHash: string | null;
}

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
};

export class EscrowClient {
    private readonly contract: Contract;

    /** Binds the client to a deployed escrow contract and AgentKred's sponsoring accounts. */
    constructor(contractId: string, private readonly sponsor: Sponsor) {
        this.contract = new Contract(contractId);
    }

    /**
     * Locks the cap from the buyer, who signs only its auth entry; AgentKred pays the fee.
     * @returns The transaction hash and the new escrow id
     */
    async lock(buyer: Keypair, seller: string, quoteHash: Buffer): Promise<Submitted & { escrowId: bigint }> {
        // Build the lock call with the quoted terms
        const operation = this.contract.call(
            "lock",
            nativeToScVal(buyer.publicKey(), { type: "address" }),
            nativeToScVal(seller, { type: "address" }),
            nativeToScVal(Config.usdc.contractId(Config.networkPassphrase), { type: "address" }),
            nativeToScVal(Config.capStroops, { type: "i128" }),
            nativeToScVal(Config.deliverSeconds, { type: "u64" }),
            nativeToScVal(Config.disputeSeconds, { type: "u64" }),
            xdr.ScVal.scvBytes(quoteHash),
        );

        // Submit through AgentKred's fee-bump and read back the escrow id
        const submitted = await Submitter.sponsored(operation, [buyer], this.sponsor.channel, this.sponsor.fees);
        return { ...submitted, escrowId: BigInt(scValToNative(submitted.returnValue!)) };
    }

    /** Records the seller's manifest hash, with AgentKred paying the fee. */
    async deliver(seller: Keypair, escrowId: bigint, manifestHash: Buffer): Promise<Submitted> {
        // Build and submit the deliver call through AgentKred's fee-bump
        const operation = this.contract.call(
            "deliver",
            nativeToScVal(escrowId, { type: "u64" }),
            xdr.ScVal.scvBytes(manifestHash),
        );
        return Submitter.sponsored(operation, [seller], this.sponsor.channel, this.sponsor.fees);
    }

    /** Settles a delivered escrow from any account, which pays its own fee. */
    async settle(caller: Keypair, escrowId: bigint): Promise<Submitted> {
        return Submitter.direct(this.contract.call("settle", nativeToScVal(escrowId, { type: "u64" })), caller);
    }

    /** Refunds an undelivered escrow from any account, which pays its own fee. */
    async refund(caller: Keypair, escrowId: bigint): Promise<Submitted> {
        return Submitter.direct(this.contract.call("refund", nativeToScVal(escrowId, { type: "u64" })), caller);
    }

    /** Reads an escrow's current state through simulation. */
    async get(escrowId: bigint, reader: string): Promise<EscrowView> {
        // Simulate get_escrow and convert the result
        const value = await Submitter.read(this.contract.call("get_escrow", nativeToScVal(escrowId, { type: "u64" })), reader);
        const raw = scValToNative(value);

        // Map the contract struct into a view
        return {
            buyer: raw.buyer,
            seller: raw.seller,
            cap: BigInt(raw.cap),
            state: Array.isArray(raw.state) ? String(raw.state[0]) : String(raw.state),
            lockedAt: Number(raw.locked_at),
            deliverBy: Number(raw.deliver_by),
            disputeBy: raw.dispute_by == null ? null : Number(raw.dispute_by),
            manifestHash: raw.manifest_hash == null ? null : Buffer.from(raw.manifest_hash).toString("hex"),
        };
    }
}
