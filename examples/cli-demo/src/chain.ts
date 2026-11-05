// Read-side access to Stellar testnet: accounts, balances, ledger time and transaction polling.

import { rpc } from "@stellar/stellar-sdk";
import { Config } from "./config.js";
import { Log } from "./log.js";

export class Chain {
    static readonly server = new rpc.Server(Config.rpcUrl);

    /** Returns true when the account exists on chain. */
    static async accountExists(address: string): Promise<boolean> {
        // Look up the account, treating any failure as missing
        try {
            await this.server.getAccount(address);
            return true;
        } catch {
            return false;
        }
    }

    /** Funds an account with testnet XLM from Friendbot. */
    static async fund(address: string): Promise<void> {
        await this.server.fundAddress(address);
    }

    /** Returns the USDC balance of an account or contract in stroops. */
    static async usdcBalance(address: string): Promise<bigint> {
        // Read the trustline or contract balance, treating a missing entry as zero
        const response = await this.server.getAssetBalance(address, Config.usdc, Config.networkPassphrase);
        return BigInt(response.balanceEntry?.amount ?? "0");
    }

    /** Returns the native XLM balance of an account in stroops. */
    static async xlmBalance(address: string): Promise<bigint> {
        // Read the account entry's balance
        const entry = await this.server.getAccountEntry(address);
        return entry.balance;
    }

    /** Returns the close time of the latest ledger in unix seconds. */
    static async ledgerTime(): Promise<number> {
        // Read the latest ledger's close time
        const latest = await this.server.getLatestLedger();
        const closeTime = latest.closeTime;

        // Accept both numeric and ISO timestamps
        return /^\d+$/.test(closeTime) ? Number(closeTime) : Math.floor(Date.parse(closeTime) / 1000);
    }

    /** Returns the latest ledger sequence. */
    static async ledgerSequence(): Promise<number> {
        return (await this.server.getLatestLedger()).sequence;
    }

    /** Waits until ledger time reaches `target`, printing a countdown. */
    static async waitForLedgerTime(target: number, label: string): Promise<void> {
        // Poll ledger time until the target passes
        let now = await this.ledgerTime();
        while (now < target) {
            Log.status(`${label}: ${target - now}s left (ledger time ${now})`);
            await sleep(Config.pollIntervalMs);
            now = await this.ledgerTime();
        }

        // Close the countdown line
        Log.status(`${label}: reached at ledger time ${now}`);
        Log.endStatus();
    }

    /** Polls a submitted transaction until it lands, failing on anything but success. */
    static async confirm(hash: string): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
        // Poll until the transaction leaves the not-found state
        const result = await this.server.pollTransaction(hash, {
            attempts: 30,
            sleepStrategy: () => Config.pollIntervalMs,
        });

        // Fail on any outcome other than success
        if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
            throw new Error(`Transaction ${hash} ended with status ${result.status}`);
        }

        return result;
    }

    /** Formats a stroop amount as a 7-decimal USDC or XLM string. */
    static format(stroops: bigint): string {
        // Split the amount into whole and fractional parts
        const scale = 10n ** BigInt(Config.usdcDecimals);
        const whole = stroops / scale;
        const fraction = (stroops % scale).toString().padStart(Config.usdcDecimals, "0");

        return `${whole}.${fraction}`;
    }
}

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
    return new Promise((done) => setTimeout(done, ms));
}
