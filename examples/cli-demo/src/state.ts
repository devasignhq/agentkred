// Local demo state: testnet keypairs for every role and the deployed contract details.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { Config } from "./config.js";

export type Role = "fees" | "channel" | "buyer" | "seller" | "anyone";

export const ROLES: Role[] = ["fees", "channel", "buyer", "seller", "anyone"];

export interface Deployment {
    contractId: string;
    wasmHash: string;
    uploadTx: string;
    deployTx: string;
}

export interface StoredState {
    secrets: Record<Role, string>;
    setupTxs: string[];
    deployment?: Deployment;
}

export class DemoState {
    /** Loads the saved state, or returns null when setup has not run yet. */
    static load(): StoredState | null {
        // Return nothing when no state file exists
        if (!existsSync(Config.statePath)) {
            return null;
        }

        // Parse the saved state
        return JSON.parse(readFileSync(Config.statePath, "utf8")) as StoredState;
    }

    /** Loads the saved state or generates a fresh keypair for every role. */
    static loadOrCreate(): StoredState {
        // Reuse the existing state when present
        const existing = this.load();
        if (existing) {
            return existing;
        }

        // Generate a new keypair per role
        const secrets = Object.fromEntries(ROLES.map((role) => [role, Keypair.random().secret()])) as Record<Role, string>;
        return { secrets, setupTxs: [] };
    }

    /** Loads the saved state and fails when setup has not deployed the contract. */
    static requireDeployed(): StoredState & { deployment: Deployment } {
        // Fail when setup has not completed
        const state = this.load();
        if (!state?.deployment) {
            throw new Error("No deployed escrow found. Run `npm run setup` first.");
        }

        return state as StoredState & { deployment: Deployment };
    }

    /** Writes the state to disk. */
    static save(state: StoredState): void {
        // Create the state directory and write the file
        mkdirSync(dirname(Config.statePath), { recursive: true });
        writeFileSync(Config.statePath, JSON.stringify(state, null, 4));
    }

    /** Returns the keypair stored for `role`. */
    static keypair(state: StoredState, role: Role): Keypair {
        return Keypair.fromSecret(state.secrets[role]);
    }
}
