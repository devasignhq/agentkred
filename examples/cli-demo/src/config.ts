// Network endpoints, asset, file paths and escrow clocks for the testnet demo.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Asset, Networks } from "@stellar/stellar-sdk";

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
    deliverSeconds: 60,
    disputeSeconds: 90,

    baseFee: "100",
    authValidityLedgers: 100,
    txTimeoutSeconds: 60,
    pollIntervalMs: 2_000,
} as const;
