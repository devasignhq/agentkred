// Builds, signs and submits Soroban and classic transactions, including fee-bumped calls signed only through auth entries.

import {
    Address,
    FeeBumpTransaction,
    Keypair,
    Operation,
    Transaction,
    TransactionBuilder,
    authorizeEntry,
    rpc,
    xdr,
} from "@stellar/stellar-sdk";
import { Chain } from "./chain.js";

export interface Submitted {
    hash: string;
    returnValue?: xdr.ScVal;
    events: xdr.ContractEvent[];
}

export class Submitter {
    /** Submits through the RPC endpoint and network settings of `chain`. */
    constructor(private readonly chain: Chain) {}

    /**
     * Submits a contract call from AgentKred's channel account inside a fee-bump paid by the fee account.
     * Buyers and sellers sign only their auth entries, so they never need XLM.
     * @param operation - An `invokeHostFunction` operation without auth
     * @param authSigners - Keypairs whose auth entries the call requires
     * @param channel - AgentKred account that sources the inner transaction
     * @param fees - AgentKred account that pays the fee-bump
     * @returns The fee-bump transaction hash and the call's return value
     */
    async sponsored(
        operation: xdr.Operation,
        authSigners: Keypair[],
        channel: Keypair,
        fees: Keypair,
    ): Promise<Submitted> {
        // Extract the host function from the operation
        const body = operation.body;
        if (body.type !== "invokeHostFunction") {
            throw new Error("Sponsored submission needs an invokeHostFunction operation");
        }
        const hostFunction = body.invokeHostFunctionOp.hostFunction;

        // Simulate once to discover the auth entries the call needs
        const recording = await this.simulate(await this.build(channel.publicKey(), operation));

        // Sign each address auth entry with its owner's key
        const validUntil = (await this.chain.ledgerSequence()) + this.chain.config.authValidityLedgers;
        const auth = await Promise.all(
            (recording.result?.auth ?? []).map((entry) => this.signAuthEntry(entry, authSigners, validUntil)),
        );

        // Rebuild with the signed auth and simulate again for exact resources
        const authorized = Operation.invokeHostFunction({ func: hostFunction, auth });
        const inner = await this.build(channel.publicKey(), authorized);
        const enforcing = await this.simulate(inner);

        // Assemble the inner transaction and sign it as the channel account
        const prepared = rpc.assembleTransaction(inner, enforcing).build();
        prepared.sign(channel);

        // Wrap it in a fee-bump paid by the fee account
        const bump = TransactionBuilder.buildFeeBumpTransaction(fees, prepared.fee, prepared, this.chain.config.networkPassphrase);
        bump.sign(fees);

        return this.send(bump);
    }

    /** Submits a contract call sourced and paid for by `source` itself. */
    async direct(operation: xdr.Operation, source: Keypair): Promise<Submitted> {
        // Simulate, attach resources and sign
        const tx = await this.build(source.publicKey(), operation);
        const prepared = await this.chain.server.prepareTransaction(tx);
        prepared.sign(source);

        return this.send(prepared);
    }

    /** Submits classic operations sourced by `source` and signed by every key in `signers`. */
    async classic(operations: xdr.Operation[], source: Keypair, signers: Keypair[]): Promise<Submitted> {
        // Build the transaction with every operation
        const account = await this.chain.server.getAccount(source.publicKey());
        const builder = new TransactionBuilder(account, {
            fee: this.chain.config.baseFee,
            networkPassphrase: this.chain.config.networkPassphrase,
        });
        operations.forEach((operation) => builder.addOperation(operation));
        const tx = builder.setTimeout(this.chain.config.txTimeoutSeconds).build();

        // Sign with the source and every extra signer
        tx.sign(source, ...signers);

        return this.send(tx);
    }

    /** Simulates a read-only contract call and returns its result value. */
    async read(operation: xdr.Operation, source: string): Promise<xdr.ScVal> {
        // Simulate the call and return its result
        const simulation = await this.simulate(await this.build(source, operation));
        if (!simulation.result) {
            throw new Error("Simulation returned no result");
        }

        return simulation.result.retval;
    }

    /** Builds a single-operation transaction from `source`. */
    private async build(source: string, operation: xdr.Operation): Promise<Transaction> {
        // Load the source account and build the transaction
        const account = await this.chain.server.getAccount(source);
        return new TransactionBuilder(account, {
            fee: this.chain.config.baseFee,
            networkPassphrase: this.chain.config.networkPassphrase,
        })
            .addOperation(operation)
            .setTimeout(this.chain.config.txTimeoutSeconds)
            .build();
    }

    /** Simulates a transaction and throws the contract error when simulation fails. */
    private async simulate(tx: Transaction): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
        // Simulate and surface failures as errors
        const simulation = await this.chain.server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(simulation)) {
            throw new SimulationError(simulation.error);
        }

        return simulation as rpc.Api.SimulateTransactionSuccessResponse;
    }

    /** Signs an address-credential auth entry with the matching keypair. */
    private async signAuthEntry(
        entry: xdr.SorobanAuthorizationEntry,
        signers: Keypair[],
        validUntil: number,
    ): Promise<xdr.SorobanAuthorizationEntry> {
        // Leave source-account credentials untouched
        const credentials = entry.credentials;
        if (credentials.type !== "sorobanCredentialsAddress" && credentials.type !== "sorobanCredentialsAddressV2") {
            return entry;
        }

        // Find the keypair for the address that must authorize
        const address = Address.fromScAddress(credentials.value.address).toString();
        const signer = signers.find((keypair) => keypair.publicKey() === address);
        if (!signer) {
            throw new Error(`No signer provided for auth entry of ${address}`);
        }

        return authorizeEntry(entry, signer, validUntil, this.chain.config.networkPassphrase);
    }

    /** Sends a signed transaction and waits for it to succeed. */
    private async send(tx: Transaction | FeeBumpTransaction): Promise<Submitted> {
        // Send the transaction and fail on immediate rejection
        const sent = await this.chain.server.sendTransaction(tx);
        if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
            throw new Error(`Transaction rejected with status ${sent.status}: ${sent.errorResult?.toXDR("base64") ?? ""}`);
        }

        // Wait for confirmation and return the hash, value and contract events
        const result = await this.chain.confirm(sent.hash);
        return { hash: sent.hash, returnValue: result.returnValue, events: result.events?.contractEventsXdr.flat() ?? [] };
    }
}

/** A failed simulation, carrying the raw RPC error text. */
export class SimulationError extends Error {
    /** Returns the escrow contract error code in the message, if any. */
    contractErrorCode(): number | null {
        // Extract the code from an `Error(Contract, #N)` fragment
        const match = /Error\(Contract, #(\d+)\)/.exec(this.message);
        return match ? Number(match[1]) : null;
    }
}
