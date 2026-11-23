// Typed decoding of the escrow contract's events from their topics and data.

import { scValToNative, xdr } from "@stellar/stellar-sdk";

export type SettleOutcome = "Acknowledged" | "Silent" | "Disputed";
export type RefundReason = "NotAccepted" | "NotDelivered";

export type EscrowEvent =
    | {
          name: "escrow_locked";
          escrowId: bigint;
          buyer: string;
          seller: string;
          asset: string;
          cap: bigint;
          floor: bigint;
          jobId: string;
          quoteHash: string;
          acceptBy: number;
      }
    | { name: "escrow_accepted"; escrowId: bigint; deliverBy: number }
    | { name: "escrow_delivered"; escrowId: bigint; manifestHash: string; disputeBy: number }
    | { name: "escrow_acknowledged"; escrowId: bigint; buyer: string }
    | { name: "escrow_disputed"; escrowId: bigint; buyer: string; completeness: number }
    | {
          name: "escrow_settled";
          escrowId: bigint;
          buyer: string;
          seller: string;
          outcome: SettleOutcome;
          completeness: number;
          payout: bigint;
          remainder: bigint;
      }
    | { name: "escrow_refunded"; escrowId: bigint; buyer: string; reason: RefundReason; amount: bigint }
    | { name: "contract_upgraded"; newWasmHash: string; admin: string };

export class EscrowEvents {
    /** Decodes one contract event, or returns null when its name is not an escrow contract event. */
    static decode(topics: xdr.ScVal[], data: xdr.ScVal): EscrowEvent | null {
        // Read the event name and its data map
        const name = topics.length > 0 ? scValToNative(topics[0]) : null;
        const fields = scValToNative(data);

        // Return the upgrade event, the only one without an escrow id topic
        if (name === "contract_upgraded") {
            return { name, newWasmHash: hex(fields.new_wasm_hash), admin: fields.admin };
        }

        // Read the escrow id from the second topic
        if (topics.length < 2) {
            return null;
        }
        const escrowId = BigInt(scValToNative(topics[1]));

        // Map each event's fields into its typed form
        switch (name) {
            case "escrow_locked":
                return {
                    name,
                    escrowId,
                    buyer: fields.buyer,
                    seller: fields.seller,
                    asset: fields.asset,
                    cap: BigInt(fields.cap),
                    floor: BigInt(fields.floor),
                    jobId: hex(fields.job_id),
                    quoteHash: hex(fields.quote_hash),
                    acceptBy: Number(fields.accept_by),
                };
            case "escrow_accepted":
                return { name, escrowId, deliverBy: Number(fields.deliver_by) };
            case "escrow_delivered":
                return { name, escrowId, manifestHash: hex(fields.manifest_hash), disputeBy: Number(fields.dispute_by) };
            case "escrow_acknowledged":
                return { name, escrowId, buyer: fields.buyer };
            case "escrow_disputed":
                return { name, escrowId, buyer: fields.buyer, completeness: Number(fields.completeness) };
            case "escrow_settled":
                return {
                    name,
                    escrowId,
                    buyer: fields.buyer,
                    seller: fields.seller,
                    outcome: variantName(fields.outcome) as SettleOutcome,
                    completeness: Number(fields.completeness),
                    payout: BigInt(fields.payout),
                    remainder: BigInt(fields.remainder),
                };
            case "escrow_refunded":
                return {
                    name,
                    escrowId,
                    buyer: fields.buyer,
                    reason: variantName(fields.reason) as RefundReason,
                    amount: BigInt(fields.amount),
                };
            default:
                return null;
        }
    }
}

/** Returns the name of a contract unit enum, which decodes as a one-element array. */
export function variantName(value: unknown): string {
    return Array.isArray(value) ? String(value[0]) : String(value);
}

/** Encodes contract bytes as hex. */
function hex(value: Uint8Array): string {
    return Buffer.from(value).toString("hex");
}
