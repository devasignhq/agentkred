// Demo state tests: keys are split from the committed state and must match its accounts when joined.

import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { DemoState, ROLES, Role, StoredState } from "../src/state.js";

/** Builds a state with a fresh keypair per role and one deployment. */
function freshState(): StoredState {
    // Generate a keypair per role
    const keypairs = Object.fromEntries(ROLES.map((role) => [role, Keypair.random()])) as Record<Role, Keypair>;

    // Record the keys, their accounts and a deployment
    return {
        secrets: Object.fromEntries(ROLES.map((role) => [role, keypairs[role].secret()])) as Record<Role, string>,
        accounts: Object.fromEntries(ROLES.map((role) => [role, keypairs[role].publicKey()])) as Record<Role, string>,
        setupTxs: ["aa"],
        deployment: { contractId: "C1", wasmHash: "bb", uploadTx: "cc", deployTx: "dd" },
    };
}

describe("DemoState", () => {
    it("keeps every secret key out of the public state", () => {
        const { state } = DemoState.split(freshState());

        expect(state).not.toHaveProperty("secrets");
        expect(JSON.stringify(state)).not.toMatch(/"S[A-Z2-7]{55}"/);
    });

    it("joins the split halves back into the original state", () => {
        const original = freshState();
        const { state, secrets } = DemoState.split(original);

        expect(DemoState.join(state, secrets)).toEqual(original);
    });

    it("refuses keys that do not match the recorded accounts", () => {
        const { state } = DemoState.split(freshState());
        const { secrets } = DemoState.split(freshState());

        expect(() => DemoState.join(state, secrets)).toThrow(/does not match/);
    });

    it("refuses public state with no recorded accounts", () => {
        const { state, secrets } = DemoState.split(freshState());
        const { accounts: _, ...withoutAccounts } = state;

        expect(() => DemoState.join(withoutAccounts as typeof state, secrets)).toThrow(/does not match/);
    });
});
