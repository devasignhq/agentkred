// Network endpoints, asset, file paths, quote terms and escrow clocks for the testnet demo.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Asset, Networks } from "@stellar/stellar-sdk";
import { PayoutStep } from "./quote.js";

const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(demoRoot, "../..");

export const Config = {
    rpcUrl: process.env.AGENTKRED_RPC_URL ?? "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
    explorerUrl: "https://stellar.expert/explorer/testnet",
    faucetUrl: "https://faucet.circle.com",

    usdc: new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
    usdcDecimals: 7,

    wasmPath: resolve(repoRoot, "target/wasm32v1-none/release/agentkred_escrow.wasm"),
    statePath: resolve(demoRoot, ".demo/state.json"),
    evidenceDir: resolve(demoRoot, "evidence"),

    capStroops: 10_000_000n,
    floorStroops: 2_000_000n,
    schedule: [
        { completeness: 0, payout: 2_000_000n },
        { completeness: 50, payout: 6_000_000n },
        { completeness: 100, payout: 10_000_000n },
    ] as PayoutStep[],
    disputeCompleteness: 50,
    acceptSeconds: 45,
    deliverSeconds: 60,
    disputeSeconds: 60,

    baseFee: "100",
    authValidityLedgers: 100,
    txTimeoutSeconds: 60,
    pollIntervalMs: 2_000,
} as const;
