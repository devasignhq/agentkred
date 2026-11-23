// Soroban auth entries: base64 transport and a flat view of who signed which contract call.

import { Address, Keypair, authorizeInvocation, xdr } from "@stellar/stellar-sdk";

/** One authorized contract call, with the calls it authorizes beneath it. */
export interface AuthorizedCall {
    contract: string;
    method: string;
    args: xdr.ScVal[];
    subCalls: AuthorizedCall[];
}

/** An address-signed auth entry reduced to its signer, expiry and call tree. */
export interface AuthEntryView {
    signer: string;
    expirationLedger: number;
    call: AuthorizedCall;
}

export class AuthEntries {
    /** Encodes an auth entry as base64 XDR. */
    static toBase64(entry: xdr.SorobanAuthorizationEntry): string {
        return entry.toXdr("base64");
    }

    /** Decodes an auth entry from base64 XDR. */
    static fromBase64(encoded: string): xdr.SorobanAuthorizationEntry {
        return xdr.SorobanAuthorizationEntry.fromXdr(encoded, "base64");
    }

    /** Returns the signer, expiry and call tree of an address-credential entry, or null for any other kind. */
    static describe(entry: xdr.SorobanAuthorizationEntry): AuthEntryView | null {
        // Accept only entries signed by an address
        const credentials = entry.credentials;
        if (credentials.type !== "sorobanCredentialsAddress" && credentials.type !== "sorobanCredentialsAddressV2") {
            return null;
        }

        // Flatten the invocation tree, refusing anything that is not a plain contract call
        const call = this.call(entry.rootInvocation);
        if (!call) {
            return null;
        }

        return {
            signer: Address.fromScAddress(credentials.value.address).toString(),
            expirationLedger: credentials.value.signatureExpirationLedger,
            call,
        };
    }

    /** Returns the contract call an `invokeHostFunction` operation makes, with no sub-calls. */
    static callOf(operation: xdr.Operation): AuthorizedCall {
        // Read the contract, method and arguments from the host function
        const body = operation.body;
        if (body.type !== "invokeHostFunction" || body.invokeHostFunctionOp.hostFunction.type !== "hostFunctionTypeInvokeContract") {
            throw new Error("Expected an operation that invokes a contract");
        }
        const invoke = body.invokeHostFunctionOp.hostFunction.invokeContract;

        return {
            contract: Address.fromScAddress(invoke.contractAddress).toString(),
            method: invoke.functionName.toString(),
            args: invoke.args,
            subCalls: [],
        };
    }

    /** Returns true when two call trees name the same contracts, methods and byte-identical arguments. */
    static sameCall(a: AuthorizedCall, b: AuthorizedCall): boolean {
        // Compare this level's contract, method and arguments
        if (a.contract !== b.contract || a.method !== b.method || a.args.length !== b.args.length) {
            return false;
        }
        if (!a.args.every((arg, index) => arg.equals(b.args[index]))) {
            return false;
        }

        // Compare the sub-calls in order
        return a.subCalls.length === b.subCalls.length && a.subCalls.every((call, index) => this.sameCall(call, b.subCalls[index]));
    }

    /**
     * Builds and signs an auth entry for a call tree with a fresh nonce, without simulating.
     * @param call - The call and the sub-calls it authorizes
     * @param signer - The address owner's keypair
     * @param validUntil - The last ledger the signature is valid for
     * @param networkPassphrase - The network the entry is signed for
     */
    static async sign(call: AuthorizedCall, signer: Keypair, validUntil: number, networkPassphrase: string): Promise<xdr.SorobanAuthorizationEntry> {
        return authorizeInvocation({ signer, validUntilLedgerSeq: validUntil, invocation: this.invocation(call), networkPassphrase });
    }

    /** Converts a call tree into the invocation an auth entry signs. */
    private static invocation(call: AuthorizedCall): xdr.SorobanAuthorizedInvocation {
        return new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                new xdr.InvokeContractArgs({
                    contractAddress: Address.fromString(call.contract).toScAddress(),
                    functionName: call.method,
                    args: call.args,
                }),
            ),
            subInvocations: call.subCalls.map((child) => this.invocation(child)),
        });
    }

    /** Converts an authorized invocation and its children into calls, or null if any is not a contract call. */
    private static call(invocation: xdr.SorobanAuthorizedInvocation): AuthorizedCall | null {
        // Reject contract creation and other host functions
        const fn = invocation.function;
        if (fn.type !== "sorobanAuthorizedFunctionTypeContractFn") {
            return null;
        }

        // Convert every child the same way
        const subCalls = invocation.subInvocations.map((child) => this.call(child));
        if (subCalls.some((child) => child === null)) {
            return null;
        }

        return {
            contract: Address.fromScAddress(fn.contractFn.contractAddress).toString(),
            method: fn.contractFn.functionName.toString(),
            args: fn.contractFn.args,
            subCalls: subCalls as AuthorizedCall[],
        };
    }
}
