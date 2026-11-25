// Server settings read from the environment, failing fast on anything required that is missing.

import "dotenv/config";
import { Keypair } from "@stellar/stellar-sdk";
import { NetworkConfig, TESTNET } from "@agentkred/shared";

export class Env {
    /** Returns the Postgres connection URL. */
    static databaseUrl(): string {
        return this.required("DATABASE_URL");
    }

    /** Returns the HTTP port the API listens on. */
    static port(): number {
        return Number(process.env.PORT ?? 8080);
    }

    /** Returns the testnet network settings with the configured RPC endpoint. */
    static network(): NetworkConfig {
        return { ...TESTNET, rpcUrl: process.env.STELLAR_RPC_URL || TESTNET.rpcUrl };
    }

    /** Returns the deployed escrow contract's address. */
    static escrowContractId(): string {
        return this.required("ESCROW_CONTRACT_ID");
    }

    /** Returns the first ledger to ingest from, or null to start at the RPC's oldest ledger. */
    static ingestStartLedger(): number | null {
        // Parse the ledger when one is set
        const value = process.env.INGEST_START_LEDGER;
        return value ? Number(value) : null;
    }

    /** Returns AgentKred's channel account key, which sources submitted calls. */
    static channel(): Keypair {
        return Keypair.fromSecret(this.required("CHANNEL_SECRET"));
    }

    /** Returns AgentKred's fee account key, which pays every fee-bump. */
    static fees(): Keypair {
        return Keypair.fromSecret(this.required("FEE_SECRET"));
    }

    /** Returns an environment variable, throwing when it is unset or empty. */
    private static required(name: string): string {
        // Fail on a missing value
        const value = process.env[name];
        if (!value) {
            throw new Error(`${name} is not set`);
        }

        return value;
    }
}
