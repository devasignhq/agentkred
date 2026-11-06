// Drives three escrows on testnet (settled after silence, refunded, acknowledged) and prints a work record for each.

import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { Chain, sleep } from "./chain.js";
import { Config } from "./config.js";
import { ESCROW_ERRORS, EscrowClient } from "./escrowClient.js";
import { Evidence } from "./evidence.js";
import { Log } from "./log.js";
import { DemoState } from "./state.js";
import { SimulationError, Submitted } from "./submitter.js";
import { WorkRecords } from "./workRecord.js";

interface Parties {
    buyer: Keypair;
    seller: Keypair;
    anyone: Keypair;
    channel: Keypair;
    fees: Keypair;
}

interface Demo {
    client: EscrowClient;
    parties: Parties;
    evidence: Evidence;
}

const RUN_COUNT = 3n;

/** Runs the silent, refund and acknowledged paths, then writes the evidence file. */
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
    const demo: Demo = {
        client: new EscrowClient(state.deployment.contractId, { channel: parties.channel, fees: parties.fees }),
        parties,
        evidence: new Evidence(state.deployment),
    };

    // Print the contract and the demo parameters
    Log.heading("AgentKred minimal escrow on Stellar testnet");
    Log.info("contract", state.deployment.contractId);
    Log.info("explorer", `${Config.explorerUrl}/contract/${state.deployment.contractId}`);
    Log.info("cap", `${Chain.format(Config.capStroops)} USDC`);
    Log.info("deliver-by", `${Config.deliverSeconds}s after lock`);
    Log.info("dispute", `${Config.disputeSeconds}s after delivery`);

    // Check the buyer holds enough USDC for every run
    const needed = Config.capStroops * RUN_COUNT;
    const buyerUsdc = await Chain.usdcBalance(parties.buyer.publicKey());
    if (buyerUsdc < needed) {
        throw new Error(`Buyer holds ${Chain.format(buyerUsdc)} USDC but needs ${Chain.format(needed)}. Fund it at ${Config.faucetUrl}.`);
    }

    // Show starting balances
    Log.heading("Starting balances");
    await printBalances(demo, state.deployment.contractId, "Before");

    // Run the escrow the buyer never answers
    Log.heading("Run A: lock, deliver, buyer silent, settle after the dispute window");
    await runSilent(demo);

    // Run the escrow the seller never delivers
    Log.heading("Run B: lock, no delivery, refund after deliver-by");
    await runRefunded(demo);

    // Run the escrow the buyer acknowledges
    Log.heading("Run C: lock, deliver, buyer acknowledges, settle at once");
    await runAcknowledged(demo);

    // Show ending balances
    Log.heading("Ending balances");
    await printBalances(demo, state.deployment.contractId, "After");

    // Write the evidence file
    const path = demo.evidence.write();
    Log.heading("Evidence");
    Log.info("written to", path);
}

/** Locks and delivers an escrow, waits out the dispute window in silence and settles to the seller. */
async function runSilent(demo: Demo): Promise<void> {
    // Lock the cap and deliver a manifest
    const escrowId = await lock(demo, "A");
    await deliver(demo, "A", escrowId);

    // Wait for the dispute window to close
    const escrow = await demo.client.get(escrowId, demo.parties.fees.publicKey());
    Log.step("Buyer stays silent; waiting for the dispute window to close");
    await Chain.waitForLedgerTime(escrow.disputeBy!, "dispute window");

    // Settle from an unrelated third account
    Log.step("An unrelated account calls settle");
    const settled = await retryWhileEarly(() => demo.client.settle(demo.parties.anyone, escrowId), 8);
    recordClose(demo, "A", `settle(${escrowId})`, settled);

    // Print the resulting work record
    await printRecord(demo, escrowId, settled.hash);
}

/** Locks an escrow, lets deliver-by pass with no delivery and refunds the buyer. */
async function runRefunded(demo: Demo): Promise<void> {
    // Lock the cap
    const escrowId = await lock(demo, "B");

    // Wait for deliver-by to pass with no delivery
    const escrow = await demo.client.get(escrowId, demo.parties.fees.publicKey());
    Log.step("Seller never delivers; waiting for deliver-by to pass");
    await Chain.waitForLedgerTime(escrow.deliverBy, "deliver-by");

    // Refund from an unrelated third account
    Log.step("An unrelated account calls refund");
    const refunded = await retryWhileEarly(() => demo.client.refund(demo.parties.anyone, escrowId), 7);
    recordClose(demo, "B", `refund(${escrowId})`, refunded);

    // Print the resulting work record
    await printRecord(demo, escrowId, refunded.hash);
}

/** Locks and delivers an escrow, has the buyer acknowledge it and settles without waiting. */
async function runAcknowledged(demo: Demo): Promise<void> {
    // Lock the cap and deliver a manifest
    const escrowId = await lock(demo, "C");
    await deliver(demo, "C", escrowId);

    // Acknowledge the delivery as the buyer
    Log.step("Buyer verifies the artifact and acknowledges inside the dispute window");
    const acknowledged = await demo.client.acknowledge(demo.parties.buyer, escrowId);
    Log.tx(acknowledged.hash);
    Log.info("state", (await demo.client.get(escrowId, demo.parties.fees.publicKey())).state);
    demo.evidence.addStep({
        run: "C",
        step: `acknowledge(${escrowId})`,
        caller: "buyer (auth entry only)",
        feePaidBy: "AgentKred fee-bump",
        hash: acknowledged.hash,
    });

    // Settle immediately from an unrelated third account
    Log.step("An unrelated account calls settle without waiting for the window");
    const settled = await demo.client.settle(demo.parties.anyone, escrowId);
    recordClose(demo, "C", `settle(${escrowId})`, settled);

    // Print the resulting work record
    await printRecord(demo, escrowId, settled.hash);
}

/** Locks one escrow for the configured cap and records the transaction. */
async function lock(demo: Demo, run: string): Promise<bigint> {
    // Hash a quote document standing in for the seller's signed quote
    Log.step("Buyer signs one auth entry; AgentKred submits the lock in a fee-bump");
    const quote = {
        run,
        seller: demo.parties.seller.publicKey(),
        cap: Config.capStroops.toString(),
        deliverS: Config.deliverSeconds,
        disputeS: Config.disputeSeconds,
        nonce: Date.now(),
    };
    const quoteHash = sha256(JSON.stringify(quote));
    Log.info("quote hash", quoteHash.toString("hex"));

    // Submit the lock and print the new escrow
    const locked = await demo.client.lock(demo.parties.buyer, demo.parties.seller.publicKey(), quoteHash);
    const escrow = await demo.client.get(locked.escrowId, demo.parties.fees.publicKey());
    Log.info("escrow id", locked.escrowId.toString());
    Log.info("state", escrow.state);
    Log.info("deliver-by", `ledger time ${escrow.deliverBy}`);
    Log.tx(locked.hash);

    // Record the lock
    demo.evidence.addStep({
        run,
        step: `lock -> escrow ${locked.escrowId}`,
        caller: "buyer (auth entry only)",
        feePaidBy: "AgentKred fee-bump",
        hash: locked.hash,
    });

    return locked.escrowId;
}

/** Delivers a manifest hash as the seller and records the transaction. */
async function deliver(demo: Demo, run: string, escrowId: bigint): Promise<void> {
    // Hash a manifest standing in for the seller's delivery manifest
    Log.step("Seller delivers the manifest hash");
    const manifest = {
        escrowId: escrowId.toString(),
        artifactSha256: sha256(`rendered-video-${run}.mp4 contents`).toString("hex"),
        evidence: `https://seller.example/artifacts/demo-${run.toLowerCase()}`,
    };
    const manifestHash = sha256(JSON.stringify(manifest));
    Log.info("manifest hash", manifestHash.toString("hex"));

    // Submit the delivery and print the new state
    const delivered = await demo.client.deliver(demo.parties.seller, escrowId, manifestHash);
    Log.tx(delivered.hash);
    Log.info("state", (await demo.client.get(escrowId, demo.parties.fees.publicKey())).state);

    // Record the delivery
    demo.evidence.addStep({
        run,
        step: `deliver(${escrowId})`,
        caller: "seller (auth entry only)",
        feePaidBy: "AgentKred fee-bump",
        hash: delivered.hash,
    });
}

/** Prints and records a settle or refund sent by the unrelated third account. */
function recordClose(demo: Demo, run: string, step: string, submitted: Submitted): void {
    // Print the transaction and add it to the evidence
    Log.tx(submitted.hash);
    demo.evidence.addStep({
        run,
        step,
        caller: "unrelated third account",
        feePaidBy: "third account",
        hash: submitted.hash,
    });
}

/** Reads the closed escrow, then prints and records its work record. */
async function printRecord(demo: Demo, escrowId: bigint, closeTx: string): Promise<void> {
    // Read the closed escrow and build its record
    const escrow = await demo.client.get(escrowId, demo.parties.fees.publicKey());
    const record = WorkRecords.build(escrowId, escrow, closeTx);

    // Print the record and add it to the evidence
    WorkRecords.print(record);
    demo.evidence.addRecord(record);
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
async function printBalances(demo: Demo, contractId: string, label: string): Promise<void> {
    // Read balances for the buyer, the seller and the escrow contract
    const rows: [string, string, boolean][] = [
        ["buyer", demo.parties.buyer.publicKey(), true],
        ["seller", demo.parties.seller.publicKey(), true],
        ["escrow", contractId, false],
    ];

    // Print each balance and add it to the evidence
    for (const [name, address, hasXlm] of rows) {
        const usdc = Chain.format(await Chain.usdcBalance(address));
        const xlm = hasXlm ? `, ${Chain.format(await Chain.xlmBalance(address))} XLM` : "";
        Log.info(name, `${usdc} USDC${xlm}`);
        demo.evidence.addNote(`${label}: ${name} \`${address}\` holds ${usdc} USDC${xlm}`);
    }
}

/** Returns the SHA-256 digest of `text`. */
function sha256(text: string): Buffer {
    return createHash("sha256").update(text).digest();
}

main().catch((error) => {
    console.error(`\nDemo failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
