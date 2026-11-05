// One-time testnet setup: funds AgentKred's accounts, opens zero-XLM buyer and seller accounts, and deploys the escrow.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Address, Keypair, Operation } from "@stellar/stellar-sdk";
import { Chain } from "./chain.js";
import { Config } from "./config.js";
import { Log } from "./log.js";
import { Deployment, DemoState, StoredState } from "./state.js";
import { Submitter } from "./submitter.js";

/** Runs every setup stage and prints what the buyer still needs. */
async function main(): Promise<void> {
    // Load existing keys or generate a fresh set
    const state = DemoState.loadOrCreate();
    DemoState.save(state);
    const fees = DemoState.keypair(state, "fees");
    const channel = DemoState.keypair(state, "channel");
    const buyer = DemoState.keypair(state, "buyer");
    const seller = DemoState.keypair(state, "seller");
    const anyone = DemoState.keypair(state, "anyone");

    // Fund AgentKred's accounts and the third-party caller from Friendbot
    Log.heading("Funding accounts with Friendbot");
    for (const [label, keypair] of [["fees", fees], ["channel", channel], ["anyone", anyone]] as const) {
        await ensureFunded(label, keypair);
    }

    // Open the buyer and seller as zero-XLM accounts with USDC trustlines
    Log.heading("Opening zero-XLM buyer and seller accounts");
    await openSponsoredAccounts(state, fees, [buyer, seller]);

    // Check Circle's USDC contract is live on testnet
    Log.heading("Checking testnet USDC");
    const usdcContract = Config.usdc.contractId(Config.networkPassphrase);
    await Chain.server.getContractInstance(usdcContract);
    Log.info("USDC contract", usdcContract);

    // Upload and deploy the escrow contract when it is missing or out of date
    Log.heading("Deploying the escrow contract");
    state.deployment = await ensureDeployed(state.deployment, fees);
    DemoState.save(state);

    // Print the buyer's funding instructions
    Log.heading("Next step");
    const buyerUsdc = await Chain.usdcBalance(buyer.publicKey());
    Log.info("buyer", buyer.publicKey());
    Log.info("buyer USDC", Chain.format(buyerUsdc));
    if (buyerUsdc < Config.capStroops * 2n) {
        console.log(`\n  Fund the buyer with testnet USDC at ${Config.faucetUrl} (network: Stellar Testnet),`);
        console.log("  using the buyer address above, then run `npm run demo`.");
    } else {
        console.log("\n  The buyer is funded. Run `npm run demo`.");
    }
}

/** Funds `keypair` from Friendbot unless its account already exists. */
async function ensureFunded(label: string, keypair: Keypair): Promise<void> {
    // Skip accounts that already exist
    if (await Chain.accountExists(keypair.publicKey())) {
        Log.info(label, `${keypair.publicKey()} (exists)`);
        return;
    }

    // Request testnet XLM
    await Chain.fund(keypair.publicKey());
    Log.info(label, `${keypair.publicKey()} (funded)`);
}

/** Creates each missing account with zero XLM, its reserves and USDC trustline sponsored by `fees`. */
async function openSponsoredAccounts(state: StoredState, fees: Keypair, accounts: Keypair[]): Promise<void> {
    // Keep only the accounts that do not exist yet
    const missing: Keypair[] = [];
    for (const keypair of accounts) {
        if (!(await Chain.accountExists(keypair.publicKey()))) {
            missing.push(keypair);
        }
    }

    // Report and stop when every account already exists
    if (missing.length === 0) {
        accounts.forEach((keypair) => Log.info("exists", keypair.publicKey()));
        return;
    }

    // Wrap each account's creation and trustline in a sponsorship block
    const operations = missing.flatMap((keypair) => [
        Operation.beginSponsoringFutureReserves({ sponsoredId: keypair.publicKey() }),
        Operation.createAccount({ destination: keypair.publicKey(), startingBalance: "0" }),
        Operation.changeTrust({ asset: Config.usdc, source: keypair.publicKey() }),
        Operation.endSponsoringFutureReserves({ source: keypair.publicKey() }),
    ]);

    // Submit with the fee account as source and every new account co-signing
    const submitted = await Submitter.classic(operations, fees, missing);
    state.setupTxs.push(submitted.hash);
    missing.forEach((keypair) => Log.info("opened", keypair.publicKey()));
    Log.tx(submitted.hash);
}

/** Uploads and deploys the escrow WASM unless the current build is already deployed. */
async function ensureDeployed(current: Deployment | undefined, fees: Keypair): Promise<Deployment> {
    // Read the built WASM and hash it
    if (!existsSync(Config.wasmPath)) {
        throw new Error(`Contract WASM not found at ${Config.wasmPath}. Run \`npm run build:contract\` first.`);
    }
    const wasm = readFileSync(Config.wasmPath);
    const wasmHash = createHash("sha256").update(wasm).digest("hex");

    // Reuse the deployment when it already runs this build
    if (current?.wasmHash === wasmHash && !process.argv.includes("--redeploy")) {
        Log.info("contract", `${current.contractId} (already deployed)`);
        return current;
    }

    // Upload the WASM
    Log.step("Uploading WASM");
    const upload = await Submitter.direct(Operation.uploadContractWasm({ wasm }), fees);
    Log.info("wasm hash", wasmHash);
    Log.tx(upload.hash);

    // Deploy a contract instance from the uploaded WASM
    Log.step("Deploying contract");
    const deploy = await Submitter.direct(
        Operation.createCustomContract({
            address: Address.fromString(fees.publicKey()),
            wasmHash: Buffer.from(wasmHash, "hex"),
            salt: randomBytes(32),
        }),
        fees,
    );
    const contractId = Address.fromScVal(deploy.returnValue!).toString();
    Log.info("contract", contractId);
    Log.tx(deploy.hash);

    return { contractId, wasmHash, uploadTx: upload.hash, deployTx: deploy.hash };
}

main().catch((error) => {
    console.error(`\nSetup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
