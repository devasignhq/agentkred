// The server's Stellar clients, built once from the environment on first use.

import { Keypair } from "@stellar/stellar-sdk";
import { Chain, EscrowClient, Submitter } from "@agentkred/shared";
import { Env } from "./env.js";

export class StellarService {
    private clients?: { chain: Chain; submitter: Submitter; escrow: EscrowClient };

    /** Returns the chain reader. */
    get chain(): Chain {
        return this.build().chain;
    }

    /** Returns the transaction submitter. */
    get submitter(): Submitter {
        return this.build().submitter;
    }

    /** Returns the escrow contract client. */
    get escrow(): EscrowClient {
        return this.build().escrow;
    }

    /** Returns the escrow contract's address. */
    get contractId(): string {
        return this.escrow.contractId;
    }

    /** Returns the USDC token contract's address on this network. */
    get usdcContractId(): string {
        return this.chain.config.usdc.contractId(this.chain.config.networkPassphrase);
    }

    /** Returns AgentKred's channel and fee accounts. */
    sponsor(): { channel: Keypair; fees: Keypair } {
        return { channel: Env.channel(), fees: Env.fees() };
    }

    /** Builds the clients from the environment the first time any is needed. */
    private build(): { chain: Chain; submitter: Submitter; escrow: EscrowClient } {
        // Connect the reader, submitter and contract client once
        if (!this.clients) {
            const chain = new Chain(Env.network());
            const submitter = new Submitter(chain);
            this.clients = { chain, submitter, escrow: new EscrowClient(Env.escrowContractId(), submitter) };
        }

        return this.clients;
    }
}

export const stellar = new StellarService();
