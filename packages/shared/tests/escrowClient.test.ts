// Escrow client tests: terminal events are read from a transaction's contract events, and contract error codes from simulation errors.

import { Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { EscrowClient } from "../src/escrowClient.js";
import { SimulationError, Submitted, Submitter } from "../src/submitter.js";

const CONTRACT_BYTES = Buffer.alloc(32, 5);
const CONTRACT_ID = StrKey.encodeContract(CONTRACT_BYTES);
const OTHER_CONTRACT_BYTES = Buffer.alloc(32, 6);

/** Builds a client for the test contract; terminal events need no network. */
function client(): EscrowClient {
    return new EscrowClient(CONTRACT_ID, {} as Submitter, { channel: Keypair.random(), fees: Keypair.random() });
}

/** Encodes a unit enum variant as the contract does: a one-element vector holding its name. */
function variant(name: string): xdr.ScVal {
    return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]);
}

/** Builds a contract event with a symbol name, an escrow id topic and a symbol-keyed data map. */
function event(emitter: Buffer, name: string, data: Record<string, xdr.ScVal>): xdr.ContractEvent {
    // Encode the data as a map with keys in sorted order
    const entries = Object.keys(data)
        .sort()
        .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: data[key] }));

    // Wrap the topics and data in a contract event from `emitter`
    return new xdr.ContractEvent({
        ext: xdr.ExtensionPoint.v0(),
        contractId: xdr.ContractId.fromXdrObject(emitter),
        type: xdr.ContractEventType.contract,
        body: xdr.ContractEventBody.v0(
            new xdr.ContractEventV0({
                topics: [xdr.ScVal.scvSymbol(name), nativeToScVal(1n, { type: "u64" })],
                data: xdr.ScVal.scvMap(entries),
            }),
        ),
    });
}

/** Wraps events in a submitted transaction. */
function submitted(events: xdr.ContractEvent[]): Submitted {
    return { hash: "ab".repeat(32), ledger: 1, events };
}

describe("EscrowClient.terminalEvent", () => {
    it("reads a settlement's outcome, completeness and split", () => {
        const settled = event(CONTRACT_BYTES, "escrow_settled", {
            outcome: variant("Disputed"),
            completeness: nativeToScVal(50, { type: "u32" }),
            payout: nativeToScVal(6_000_000n, { type: "i128" }),
            remainder: nativeToScVal(4_000_000n, { type: "i128" }),
        });

        expect(client().terminalEvent(submitted([settled]))).toEqual({
            kind: "settled",
            outcome: "Disputed",
            completeness: 50,
            payout: 6_000_000n,
            remainder: 4_000_000n,
        });
    });

    it("reads a refund's reason and amount", () => {
        const refunded = event(CONTRACT_BYTES, "escrow_refunded", {
            reason: variant("NotDelivered"),
            amount: nativeToScVal(10_000_000n, { type: "i128" }),
        });

        expect(client().terminalEvent(submitted([refunded]))).toEqual({
            kind: "refunded",
            reason: "NotDelivered",
            amount: 10_000_000n,
        });
    });

    it("skips events from other contracts and non-terminal escrow events", () => {
        // Put a token event and a progress event ahead of the refund
        const token = event(OTHER_CONTRACT_BYTES, "escrow_refunded", {
            reason: variant("NotAccepted"),
            amount: nativeToScVal(1n, { type: "i128" }),
        });
        const progress = event(CONTRACT_BYTES, "escrow_accepted", { deliver_by: nativeToScVal(9n, { type: "u64" }) });
        const refunded = event(CONTRACT_BYTES, "escrow_refunded", {
            reason: variant("NotAccepted"),
            amount: nativeToScVal(10_000_000n, { type: "i128" }),
        });

        // Check only this contract's terminal event is returned
        expect(client().terminalEvent(submitted([token, progress, refunded]))).toMatchObject({ reason: "NotAccepted", amount: 10_000_000n });
    });

    it("fails when the transaction closed no escrow", () => {
        const progress = event(CONTRACT_BYTES, "escrow_accepted", { deliver_by: nativeToScVal(9n, { type: "u64" }) });

        expect(() => client().terminalEvent(submitted([progress]))).toThrow("no settle or refund event");
    });
});

describe("SimulationError.contractErrorCode", () => {
    it("extracts the contract error code from the RPC message", () => {
        const error = new SimulationError("HostError: Error(Contract, #16)\n\nEvent log (newest first): ...");

        expect(error.contractErrorCode()).toBe(16);
    });

    it("returns null for errors that are not contract errors", () => {
        expect(new SimulationError("HostError: Error(Crypto, InvalidInput)").contractErrorCode()).toBeNull();
    });
});
