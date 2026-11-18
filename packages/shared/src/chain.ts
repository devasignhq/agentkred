// Read-side access to a Stellar network: accounts, balances, ledger time and transaction polling.

import { rpc } from "@stellar/stellar-sdk";
import { NetworkConfig, sleep } from "./network.js";

export class Chain {
    readonly server: rpc.Server;

    /** Connects to the RPC endpoint of `config`. */
    constructor(readonly config: NetworkConfig) {
        this.server = new rpc.Server(config.rpcUrl);
    }

    /** Returns true when the account exists on chain. */
    async accountExists(address: string): Promise<boolean> {
        // Look up the account, treating any failure as missing
        try {
            await this.server.getAccount(address);
            return true;
        } catch {
            return false;
        }
    }

    /** Funds an account with XLM from Friendbot, on networks that have one. */
    async fund(address: string): Promise<void> {
        await this.server.fundAddress(address);
    }

    /** Returns the USDC balance of an account or contract in stroops, or zero when it holds none. */
    async usdcBalance(address: string): Promise<bigint> {
        // Read the trustline or contract balance, treating a missing entry as zero
        try {
            const response = await this.server.getAssetBalance(address, this.config.usdc, this.config.networkPassphrase);
            return BigInt(response.balanceEntry?.amount ?? "0");
        } catch {
            return 0n;
        }
    }

    /** Returns the native XLM balance of an account in stroops. */
    async xlmBalance(address: string): Promise<bigint> {
        // Read the account entry's balance
        const entry = await this.server.getAccountEntry(address);
        return entry.balance;
    }

    /** Returns the close time of the latest ledger in unix seconds. */
    async ledgerTime(): Promise<number> {
        // Read the latest ledger's close time
        const latest = await this.server.getLatestLedger();
        const closeTime = latest.closeTime;

        // Accept both numeric and ISO timestamps
        return /^\d+$/.test(closeTime) ? Number(closeTime) : Math.floor(Date.parse(closeTime) / 1000);
    }

    /** Returns the latest ledger sequence. */
    async ledgerSequence(): Promise<number> {
        return (await this.server.getLatestLedger()).sequence;
    }

    /**
     * Waits until ledger time reaches `target`.
     * @param target - Ledger time to wait for, in unix seconds
     * @param onTick - Called with the current ledger time on every poll
     * @returns The ledger time once the target has passed
     */
    async waitForLedgerTime(target: number, onTick?: (now: number) => void): Promise<number> {
        // Poll ledger time until the target passes
        let now = await this.ledgerTime();
        while (now < target) {
            onTick?.(now);
            await sleep(this.config.pollIntervalMs);
            now = await this.ledgerTime();
        }

        return now;
    }

    /** Polls a submitted transaction until it lands, failing on anything but success. */
    async confirm(hash: string): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
        // Poll until the transaction leaves the not-found state
        const result = await this.server.pollTransaction(hash, {
            attempts: 30,
            sleepStrategy: () => this.config.pollIntervalMs,
        });

        // Fail on any outcome other than success
        if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
            throw new Error(`Transaction ${hash} ended with status ${result.status}`);
        }

        return result;
    }
}
