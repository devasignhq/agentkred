// Network settings every chain client is built from, with Stellar testnet defaults.

import { Asset, Networks } from "@stellar/stellar-sdk";

export interface NetworkConfig {
    rpcUrl: string;
    networkPassphrase: string;
    usdc: Asset;
    baseFee: string;
    authValidityLedgers: number;
    txTimeoutSeconds: number;
    pollIntervalMs: number;
}

export const USDC_DECIMALS = 7;

export const TESTNET: NetworkConfig = {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
    usdc: new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
    baseFee: "100",
    authValidityLedgers: 100,
    txTimeoutSeconds: 60,
    pollIntervalMs: 2_000,
};

export class Amounts {
    /** Formats a stroop amount as a 7-decimal USDC or XLM string. */
    static format(stroops: bigint): string {
        // Split the amount into whole and fractional parts
        const scale = 10n ** BigInt(USDC_DECIMALS);
        const sign = stroops < 0n ? "-" : "";
        const magnitude = stroops < 0n ? -stroops : stroops;
        const fraction = (magnitude % scale).toString().padStart(USDC_DECIMALS, "0");

        return `${sign}${magnitude / scale}.${fraction}`;
    }
}

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
    return new Promise((done) => setTimeout(done, ms));
}
