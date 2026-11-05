// Drives two escrows on testnet, one delivered and settled and one refunded on timeout, then writes the evidence file.

import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { Chain, sleep } from "./chain.js";
import { Config } from "./config.js";
import { ESCROW_ERRORS, EscrowClient } from "./escrowClient.js";
import { Evidence } from "./evidence.js";
import { Log } from "./log.js";
import { DemoState } from "./state.js";
import { SimulationError, Submitted } from "./submitter.js";

interface Parties {
    buyer: Keypair;
    seller: Keypair;
    anyone: Keypair;
    channel: Keypair;
    fees: Keypair;
}

/** Runs the happy path and the timeout path, then writes the evidence file. */
async function main(): Promise<void> {
    // Load the deployed contract and every role's keys
    const state = DemoState.requireDeployed();
    const parties: Parties = {
        buyer: DemoState.keypair(state, "buyer"),
        seller: DemoState.keypair(state, "seller"),
        anyone: DemoState.keypair(state, "anyone"),
        channel: DemoState.keypair(state, "channel"),
        fees: DemoState.keypair(state, "fees"),
    };
    const client = new EscrowClient(state.deployment.contractId, { channel: parties.channel, fees: parties.fees });
    const evidence = new Evidence(state.deployment);

    // Print the contract and the demo parameters
    Log.heading("AgentKred minimal escrow on Stellar testnet");
    Log.info("contract", state.deployment.contractId);
    Log.info("explorer", `${Config.explorerUrl}/contract/${state.deployment.contractId}`);
    Log.info("cap", `${Chain.format(Config.capStroops)} USDC`);
    Log.info("deliver-by", `${Config.deliverSeconds}s after lock`);
    Log.info("dispute", `${Config.disputeSeconds}s after delivery`);

    // Check the buyer holds enough USDC for both runs
    const needed = Config.capStroops * 2n;
    const buyerUsdc = await Chain.usdcBalance(parties.buyer.publicKey());
    if (buyerUsdc < needed) {
        throw new Error(`Buyer holds ${Chain.format(buyerUsdc)} USDC but needs ${Chain.format(needed)}. Fund it at ${Config.faucetUrl}.`);
    }

    // Show starting balances
    Log.heading("Starting balances");
    await printBalances(parties, state.deployment.contractId, evidence, "Before");

    // Run the delivered-and-settled escrow
    Log.heading("Run A: lock, deliver, settle");
    await runSettled(client, parties, evidence);

    // Run the refunded-on-timeout escrow
    Log.heading("Run B: lock, no delivery, refund");
    await runRefunded(client, parties, evidence);

    // Show ending balances
    Log.heading("Ending balances");
    await printBalances(parties, state.deployment.contractId, evidence, "After");

    // Write the evidence file
    const path = evidence.write();
    Log.heading("Evidence");
    Log.info("written to", path);
}

/** Locks an escrow, delivers a manifest, waits out the dispute window and settles to the seller. */
async function runSettled(client: EscrowClient, parties: Parties, evidence: Evidence): Promise<void> {
    // Lock the cap with the buyer's single authorization
    const escrowId = await lock(client, parties, evidence, "A");

    // Deliver a manifest hash as the seller
    Log.step("Seller delivers the manifest hash");
    const manifest = {
        escrowId: escrowId.toString(),
        artifactSha256: sha256Hex("rendered-video.mp4 contents"),
        evidence: "https://seller.example/artifacts/demo-a",
    };
    const manifestHash = sha256(JSON.stringify(manifest));
    Log.info("manifest hash", manifestHash.toString("hex"));
    const delivered = await client.deliver(parties.seller, escrowId, manifestHash);
    Log.tx(delivered.hash);
    evidence.addStep({
        run: "A",
        step: `deliver(${escrowId})`,
        caller: "seller (auth entry only)",
        feePaidBy: "AgentKred fee-bump",
        hash: delivered.hash,
    });

    // Wait for the dispute window to close
    const escrow = await client.get(escrowId, parties.fees.publicKey());
    Log.info("state", escrow.state);
    Log.step("Buyer stays silent; waiting for the dispute window to close");
    await Chain.waitForLedgerTime(escrow.disputeBy!, "dispute window");

    // Settle from an unrelated third account
    Log.step("An unrelated account calls settle");
    const settled = await retryWhileEarly(() => client.settle(parties.anyone, escrowId), 8);
    Log.tx(settled.hash);
    evidence.addStep({
        run: "A",
        step: `settle(${escrowId})`,
        caller: "unrelated third account",
        feePaidBy: "third account",
        hash: settled.hash,
    });

    // Confirm the final state
    Log.info("state", (await client.get(escrowId, parties.fees.publicKey())).state);
}

/** Locks an escrow, lets deliver-by pass with no delivery and refunds the buyer. */
async function runRefunded(client: EscrowClient, parties: Parties, evidence: Evidence): Promise<void> {
    // Lock the cap with the buyer's single authorization
    const escrowId = await lock(client, parties, evidence, "B");

    // Wait for deliver-by to pass with no delivery
    const escrow = await client.get(escrowId, parties.fees.publicKey());
    Log.step("Seller never delivers; waiting for deliver-by to pass");
    await Chain.waitForLedgerTime(escrow.deliverBy, "deliver-by");

    // Refund from an unrelated third account
    Log.step("An unrelated account calls refund");
    const refunded = await retryWhileEarly(() => client.refund(parties.anyone, escrowId), 7);
    Log.tx(refunded.hash);
    evidence.addStep({
        run: "B",
        step: `refund(${escrowId})`,
        caller: "unrelated third account",
        feePaidBy: "third account",
        hash: refunded.hash,
    });

    // Confirm the final state
    Log.info("state", (await client.get(escrowId, parties.fees.publicKey())).state);
}

/** Locks one escrow for the configured cap and records the transaction. */
async function lock(client: EscrowClient, parties: Parties, evidence: Evidence, run: string): Promise<bigint> {
    // Hash a quote document standing in for the seller's signed quote
    Log.step("Buyer signs one auth entry; AgentKred submits the lock in a fee-bump");
    const quote = {
        run,
        seller: parties.seller.publicKey(),
        cap: Config.capStroops.toString(),
        deliverS: Config.deliverSeconds,
        disputeS: Config.disputeSeconds,
        nonce: Date.now(),
    };
    const quoteHash = sha256(JSON.stringify(quote));
    Log.info("quote hash", quoteHash.toString("hex"));

    // Submit the lock and print the new escrow
    const locked = await client.lock(parties.buyer, parties.seller.publicKey(), quoteHash);
    const escrow = await client.get(locked.escrowId, parties.fees.publicKey());
    Log.info("escrow id", locked.escrowId.toString());
    Log.info("state", escrow.state);
    Log.info("deliver-by", `ledger time ${escrow.deliverBy}`);
    Log.tx(locked.hash);

    // Record the lock
    evidence.addStep({
        run,
        step: `lock -> escrow ${locked.escrowId}`,
        caller: "buyer (auth entry only)",
        feePaidBy: "AgentKred fee-bump",
        hash: locked.hash,
    });

    return locked.escrowId;
}

/** Retries a call while the contract reports the deadline `earlyCode` has not passed yet. */
async function retryWhileEarly(call: () => Promise<Submitted>, earlyCode: number): Promise<Submitted> {
    for (;;) {
        // Attempt the call
        try {
            return await call();
        } catch (error) {
            // Rethrow anything other than the expected early-call error
            if (!(error instanceof SimulationError) || error.contractErrorCode() !== earlyCode) {
                throw error;
            }

            // Wait for the next ledger and try again
            Log.status(`${ESCROW_ERRORS[earlyCode]}; retrying on the next ledger`);
            await sleep(Config.pollIntervalMs);
        }
    }
}

/** Prints USDC and XLM balances for every party and records them as evidence notes. */
async function printBalances(parties: Parties, contractId: string, evidence: Evidence, label: string): Promise<void> {
    // Read balances for the buyer, the seller and the escrow contract
    const rows: [string, string, boolean][] = [
        ["buyer", parties.buyer.publicKey(), true],
        ["seller", parties.seller.publicKey(), true],
        ["escrow", contractId, false],
    ];

    // Print each balance and add it to the evidence
    for (const [name, address, hasXlm] of rows) {
        const usdc = Chain.format(await Chain.usdcBalance(address));
        const xlm = hasXlm ? `, ${Chain.format(await Chain.xlmBalance(address))} XLM` : "";
        Log.info(name, `${usdc} USDC${xlm}`);
        evidence.addNote(`${label}: ${name} \`${address}\` holds ${usdc} USDC${xlm}`);
    }
}

/** Returns the SHA-256 digest of `text`. */
function sha256(text: string): Buffer {
    return createHash("sha256").update(text).digest();
}

/** Returns the hex SHA-256 digest of `text`. */
function sha256Hex(text: string): string {
    return sha256(text).toString("hex");
}

main().catch((error) => {
    console.error(`\nDemo failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
