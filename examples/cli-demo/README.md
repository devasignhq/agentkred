# Testnet escrow demo

This script drives the minimal AgentKred escrow contract on Stellar testnet. It runs three escrows, one for each outcome:

- **Run A (released):** lock → deliver → the buyer stays silent → the dispute window closes → `settle` pays the seller.
- **Run B (refunded):** lock → no delivery → deliver-by passes → `refund` returns the cap to the buyer.
- **Run C (acknowledged):** lock → deliver → the buyer calls `acknowledge` → `settle` pays the seller at once, without waiting for the window.

The buyer and seller hold only USDC, with 0 XLM. They sign Soroban auth entries and nothing else. AgentKred submits their calls from a channel account inside a fee-bump, and it sponsors their account and trustline reserves. `settle` and `refund` are called by an unrelated third account, which shows that anyone can close an escrow.

After each run closes, the script reads the escrow back from the contract and prints its work record: the outcome, buyer, seller, asset, cap and payout, the payment reference (escrow id plus the settle or refund transaction), the quote and manifest hashes, and the clocks as set and as met.

When the run finishes, the script writes an evidence file to `evidence/`. It contains the contract ID, the WASM hash, every transaction hash with an explorer link, and the three work records.

## Prerequisites

- Rust with the `wasm32v1-none` target, plus the Stellar CLI
- Node.js 20 or later
- A browser to fund the buyer at [faucet.circle.com](https://faucet.circle.com)

## Running it

The repository includes `.demo/state.json`, which holds testnet-only keys and an already deployed contract with a funded buyer. To run against that setup, you only need Node.js:

```sh
npm install
cd examples/cli-demo
npm run demo
```

To start from scratch with your own accounts and contract, run these from the repository root:

```sh
npm install
cd examples/cli-demo
npm run build:contract
npm run setup
```

`setup` takes care of everything before the demo can run:

- Generates the keypairs and saves them to `.demo/state.json`, which holds testnet keys only. Delete it first to start from scratch.
- Funds AgentKred's accounts with Friendbot.
- Opens the buyer and seller as zero-XLM accounts with USDC trustlines.
- Deploys the contract.

At the end it prints the buyer's address.

Next, fund the buyer with at least 3 testnet USDC from [faucet.circle.com](https://faucet.circle.com): choose Stellar Testnet and paste the buyer's address. Then run:

```sh
npm run demo
```

The run takes about five minutes. Run it again whenever you like. Each run locks 1 USDC three times and spends 2: runs A and C each pay 1 to the seller, and run B refunds 1 to the buyer. To deploy a fresh contract after you change it, rebuild and then run `npm run setup -- --redeploy`.

## Settings

The cap (1 USDC), deliver-by window (60s) and dispute window (90s) are set in [src/config.ts](src/config.ts). Set `AGENTKRED_RPC_URL` to use a different testnet RPC endpoint.
