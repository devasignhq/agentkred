// Local demo state: public accounts and deployment in state.json, their testnet keys in the gitignored secrets.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { Config } from "./config.js";

export type Role = "fees" | "channel" | "buyer" | "seller" | "anyone";

export const ROLES: Role[] = ["fees", "channel", "buyer", "seller", "anyone"];

export interface Deployment {
    contractId: string;
    wasmHash: string;
    admin?: string;
    uploadTx: string;
    deployTx: string;
    upgradeTxs?: string[];
}

export interface PublicState {
    accounts: Record<Role, string>;
    setupTxs: string[];
    deployment?: Deployment;
}

export interface StoredState extends PublicState {
    secrets: Record<Role, string>;
}

export class DemoState {
    /** Loads the saved state, or returns null when this machine has no demo keys yet. */
    static load(): StoredState | null {
        // Return nothing until local keys exist
        if (!existsSync(Config.secretsPath)) {
            return null;
        }

        // Refuse keys whose public state is missing
        if (!existsSync(Config.statePath)) {
            throw new Error(`Found ${Config.secretsPath} but no ${Config.statePath}.`);
        }

        // Read both files and join them
        const state = JSON.parse(readFileSync(Config.statePath, "utf8")) as PublicState;
        const secrets = JSON.parse(readFileSync(Config.secretsPath, "utf8")) as Record<Role, string>;
        return this.join(state, secrets);
    }

    /** Loads the saved state, or generates a fresh keypair per role with no deployment. */
    static loadOrCreate(): StoredState {
        // Reuse the existing state when present
        const existing = this.load();
        if (existing) {
            return existing;
        }

        // Generate a new keypair per role
        const secrets = Object.fromEntries(ROLES.map((role) => [role, Keypair.random().secret()])) as Record<Role, string>;
        return { secrets, accounts: this.accountsOf(secrets), setupTxs: [] };
    }

    /** Loads the saved state and fails when setup has not deployed the contract with this machine's keys. */
    static requireDeployed(): StoredState & { deployment: Deployment } {
        // Fail when setup has not completed
        const state = this.load();
        if (!state?.deployment) {
            throw new Error("No local demo keys or deployed escrow found. Run `npm run setup` first.");
        }

        return state as StoredState & { deployment: Deployment };
    }

    /** Writes the public state and the keys to their separate files. */
    static save(state: StoredState): void {
        // Split the keys from the public state
        const { state: publicState, secrets } = this.split(state);

        // Create the state directory and write both files
        mkdirSync(dirname(Config.statePath), { recursive: true });
        writeFileSync(Config.statePath, JSON.stringify(publicState, null, 4));
        writeFileSync(Config.secretsPath, JSON.stringify(secrets, null, 4));
    }

    /** Separates the keys from the state that is safe to commit. */
    static split(state: StoredState): { state: PublicState; secrets: Record<Role, string> } {
        const { secrets, ...publicState } = state;
        return { state: publicState, secrets };
    }

    /** Joins public state with its keys, failing when any key does not match its recorded account. */
    static join(state: PublicState, secrets: Record<Role, string>): StoredState {
        // Check every role's key derives the account the state records
        const derived = this.accountsOf(secrets);
        for (const role of ROLES) {
            if (derived[role] !== state.accounts?.[role]) {
                throw new Error(`The ${role} key in ${Config.secretsPath} does not match the account in ${Config.statePath}.`);
            }
        }

        return { ...state, secrets };
    }

    /** Returns the stored keypair for `role`. */
    static keypair(state: StoredState, role: Role): Keypair {
        return Keypair.fromSecret(state.secrets[role]);
    }

    /** Derives each role's public account from its secret key. */
    private static accountsOf(secrets: Record<Role, string>): Record<Role, string> {
        return Object.fromEntries(ROLES.map((role) => [role, Keypair.fromSecret(secrets[role]).publicKey()])) as Record<Role, string>;
    }
}
