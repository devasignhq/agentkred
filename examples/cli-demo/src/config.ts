// Network settings, file paths, quote terms and escrow clocks for the testnet demo.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NetworkConfig, PayoutStep, TESTNET } from "@agentkred/shared";

const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(demoRoot, "../..");

export const Config = {
    network: { ...TESTNET, rpcUrl: process.env.AGENTKRED_RPC_URL ?? TESTNET.rpcUrl } as NetworkConfig,
    explorerUrl: "https://stellar.expert/explorer/testnet",
    faucetUrl: "https://faucet.circle.com",

    wasmPath: resolve(repoRoot, "target/wasm32v1-none/release/agentkred_escrow.wasm"),
    statePath: resolve(demoRoot, ".demo/state.json"),
    secretsPath: resolve(demoRoot, ".demo/secrets.json"),
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
} as const;
