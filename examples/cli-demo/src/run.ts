// Drives the five escrow outcomes on testnet (acknowledged, silent, disputed, not accepted, not delivered) and prints a work record for each.

import { createHash, randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { Chain, sleep } from "./chain.js";
import { Config } from "./config.js";
import { ESCROW_ERRORS, EscrowClient } from "./escrowClient.js";
import { Evidence } from "./evidence.js";
import { Log } from "./log.js";
import { Quotes } from "./quote.js";
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

const EARLY_SETTLE = 8;
const EARLY_REFUND_ACCEPT = 16;
const EARLY_REFUND_DELIVER = 7;

/** Runs the five outcomes in turn, then writes the evidence file. */
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

    // Print the contract and the quoted terms
    Log.heading("AgentKred escrow on Stellar testnet");
    Log.info("contract", state.deployment.contractId);
    Log.info("explorer", `${Config.explorerUrl}/contract/${state.deployment.contractId}`);
    Log.info("cap / floor", `${Chain.format(Config.capStroops)} / ${Chain.format(Config.floorStroops)} USDC`);
    Log.info("schedule", Config.schedule.map((step) => `${step.completeness}% -> ${Chain.format(step.payout)}`).join(", "));
    Log.info("clocks", `accept ${Config.acceptSeconds}s, deliver ${Config.deliverSeconds}s, dispute ${Config.disputeSeconds}s`);

    // Check the buyer holds enough USDC for the runs that pay the seller
    const needed = Config.capStroops * 3n;
    const buyerUsdc = await Chain.usdcBalance(parties.buyer.publicKey());
    if (buyerUsdc < needed) {
        throw new Error(`Buyer holds ${Chain.format(buyerUsdc)} USDC but needs ${Chain.format(needed)}. Fund it at ${Config.faucetUrl}.`);
    }

    // Show starting balances
    Log.heading("Starting balances");
    await printBalances(demo, state.deployment.contractId, "Before");

    // Run every outcome
    Log.heading("Run A: accept, deliver, buyer acknowledges, settle at once");
    await runAcknowledged(demo);
    Log.heading("Run B: accept, deliver, buyer silent, settle after the dispute window");
    await runSilent(demo);
    Log.heading(`Run C: accept, deliver, buyer disputes at ${Config.disputeCompleteness}%, settle at once`);
    await runDisputed(demo);
    Log.heading("Run D: seller never accepts, refund after accept-by");
    await runNotAccepted(demo);
    Log.heading("Run E: seller accepts but never delivers, refund after deliver-by");
    await runNotDelivered(demo);

    // Show ending balances
    Log.heading("Ending balances");
    await printBalances(demo, state.deployment.contractId, "After");

    // Write the evidence file
    const path = demo.evidence.write();
    Log.heading("Evidence");
    Log.info("written to", path);
}

/** Accepts and delivers an escrow, has the buyer acknowledge it and settles without waiting. */
async function runAcknowledged(demo: Demo): Promise<void> {
    // Lock, accept and deliver
    const escrowId = await lock(demo, "A");
    await accept(demo, "A", escrowId);
    await deliver(demo, "A", escrowId);

    // Acknowledge the delivery as the buyer
    Log.step("Buyer verifies the artifact and acknowledges inside the dispute window");
    const acknowledged = await demo.client.acknowledge(demo.parties.buyer, escrowId);
    recordPartyStep(demo, "A", `acknowledge(${escrowId})`, "buyer", acknowledged);

    // Settle immediately from an unrelated third account
    Log.step("An unrelated account calls settle without waiting for the window");
    const settled = await demo.client.settle(demo.parties.anyone, escrowId);
    await close(demo, "A", escrowId, `settle(${escrowId})`, settled);
}

/** Accepts and delivers an escrow, waits out the dispute window in silence and settles at the cap. */
async function runSilent(demo: Demo): Promise<void> {
    // Lock, accept and deliver
    const escrowId = await lock(demo, "B");
    await accept(demo, "B", escrowId);
    await deliver(demo, "B", escrowId);

    // Wait for the dispute window to close
    const escrow = await demo.client.get(escrowId, demo.parties.fees.publicKey());
    Log.step("Buyer stays silent; waiting for the dispute window to close");
    await Chain.waitForLedgerTime(escrow.disputeBy!, "dispute window");

    // Settle from an unrelated third account
    Log.step("An unrelated account calls settle");
    const settled = await retryWhileEarly(() => demo.client.settle(demo.parties.anyone, escrowId), EARLY_SETTLE);
    await close(demo, "B", escrowId, `settle(${escrowId})`, settled);
}

/** Accepts and delivers an escrow, has the buyer dispute it at a quoted step and settles at that price. */
async function runDisputed(demo: Demo): Promise<void> {
    // Lock, accept and deliver
    const escrowId = await lock(demo, "C");
    await accept(demo, "C", escrowId);
    await deliver(demo, "C", escrowId);

    // Dispute the delivery at the configured completeness as the buyer
    Log.step(`Buyer finds the artifact ${Config.disputeCompleteness}% complete and disputes inside the window`);
    const disputed = await demo.client.dispute(demo.parties.buyer, escrowId, Config.disputeCompleteness);
    recordPartyStep(demo, "C", `dispute(${escrowId}, ${Config.disputeCompleteness})`, "buyer", disputed);

    // Settle immediately from an unrelated third account
    Log.step("An unrelated account calls settle without waiting for the window");
    const settled = await demo.client.settle(demo.parties.anyone, escrowId);
    await close(demo, "C", escrowId, `settle(${escrowId})`, settled);
}

/** Locks an escrow the seller never accepts and refunds the buyer after accept-by. */
async function runNotAccepted(demo: Demo): Promise<void> {
    // Lock the cap
    const escrowId = await lock(demo, "D");

    // Wait for accept-by to pass with no acceptance
    const escrow = await demo.client.get(escrowId, demo.parties.fees.publicKey());
    Log.step("Seller never accepts; waiting for accept-by to pass");
    await Chain.waitForLedgerTime(escrow.acceptBy, "accept-by");

    // Refund from an unrelated third account
    Log.step("An unrelated account calls refund");
    const refunded = await retryWhileEarly(() => demo.client.refund(demo.parties.anyone, escrowId), EARLY_REFUND_ACCEPT);
    await close(demo, "D", escrowId, `refund(${escrowId})`, refunded);
}

/** Accepts an escrow the seller never delivers and refunds the buyer after deliver-by. */
async function runNotDelivered(demo: Demo): Promise<void> {
    // Lock and accept
    const escrowId = await lock(demo, "E");
    await accept(demo, "E", escrowId);

    // Wait for deliver-by to pass with no delivery
    const escrow = await demo.client.get(escrowId, demo.parties.fees.publicKey());
    Log.step("Seller never delivers; waiting for deliver-by to pass");
    await Chain.waitForLedgerTime(escrow.deliverBy!, "deliver-by");

    // Refund from an unrelated third account
    Log.step("An unrelated account calls refund");
    const refunded = await retryWhileEarly(() => demo.client.refund(demo.parties.anyone, escrowId), EARLY_REFUND_DELIVER);
    await close(demo, "E", escrowId, `refund(${escrowId})`, refunded);
}

/** Has the seller sign a fresh quote, checks it as the buyer, and locks it. */
async function lock(demo: Demo, run: string): Promise<bigint> {
    // Sign a quote for a new job as the seller
    Log.step("Seller signs a quote; buyer checks it and signs one auth entry; AgentKred submits the lock");
    const quote = Quotes.sign(
        {
            seller: demo.parties.seller.publicKey(),
            asset: Config.usdc.contractId(Config.networkPassphrase),
            cap: Config.capStroops,
            floor: Config.floorStroops,
            schedule: Config.schedule,
            acceptS: Config.acceptSeconds,
            deliverS: Config.deliverSeconds,
            disputeS: Config.disputeSeconds,
            jobId: randomBytes(32),
        },
        demo.parties.seller,
    );

    // Check the quote's hash and signature before locking
    if (!Quotes.verify(quote)) {
        throw new Error("The seller's quote failed verification");
    }
    Log.info("job id", quote.terms.jobId.toString("hex"));
    Log.info("quote hash", quote.quoteHash.toString("hex"));

    // Submit the lock and print the new escrow
    const locked = await demo.client.lock(demo.parties.buyer, quote);
    const escrow = await demo.client.get(locked.escrowId, demo.parties.fees.publicKey());
    Log.info("escrow id", locked.escrowId.toString());
    Log.info("state", escrow.state);
    Log.info("accept-by", `ledger time ${escrow.acceptBy}`);
    recordPartyStep(demo, run, `lock -> escrow ${locked.escrowId}`, "buyer", locked);

    return locked.escrowId;
}

/** Accepts the job as the seller and records the transaction. */
async function accept(demo: Demo, run: string, escrowId: bigint): Promise<void> {
    // Submit the acceptance and print the deliver-by deadline
    Log.step("Seller accepts the job");
    const accepted = await demo.client.accept(demo.parties.seller, escrowId);
    const escrow = await demo.client.get(escrowId, demo.parties.fees.publicKey());
    Log.info("deliver-by", `ledger time ${escrow.deliverBy}`);
    recordPartyStep(demo, run, `accept(${escrowId})`, "seller", accepted);
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

    // Submit the delivery and print the dispute deadline
    const delivered = await demo.client.deliver(demo.parties.seller, escrowId, manifestHash);
    const escrow = await demo.client.get(escrowId, demo.parties.fees.publicKey());
    Log.info("dispute-by", `ledger time ${escrow.disputeBy}`);
    recordPartyStep(demo, run, `deliver(${escrowId})`, "seller", delivered);
}

/** Prints and records a buyer or seller call that AgentKred fee-bumped. */
function recordPartyStep(demo: Demo, run: string, step: string, party: string, submitted: Submitted): void {
    // Print the transaction and add it to the evidence
    Log.tx(submitted.hash);
    demo.evidence.addStep({
        run,
        step,
        caller: `${party} (auth entry only)`,
        feePaidBy: "AgentKred fee-bump",
        hash: submitted.hash,
    });
}

/** Records the settle or refund sent by the third account, then prints and records the work record. */
async function close(demo: Demo, run: string, escrowId: bigint, step: string, submitted: Submitted): Promise<void> {
    // Print the closing transaction and add it to the evidence
    Log.tx(submitted.hash);
    demo.evidence.addStep({
        run,
        step,
        caller: "unrelated third account",
        feePaidBy: "third account",
        hash: submitted.hash,
    });

    // Build the work record from the closed escrow and its terminal event
    const escrow = await demo.client.get(escrowId, demo.parties.fees.publicKey());
    const record = WorkRecords.build(escrowId, escrow, submitted.hash, demo.client.terminalEvent(submitted));

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
