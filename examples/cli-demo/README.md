# Testnet escrow demo

This script drives the AgentKred escrow contract on Stellar testnet. It runs five escrows, one for each outcome:

- **Run A (acknowledged):** lock → accept → deliver → the buyer calls `acknowledge` → `settle` pays the seller the cap at once, without waiting for the window.
- **Run B (silent):** lock → accept → deliver → the buyer stays silent → the dispute window closes → `settle` pays the seller the cap.
- **Run C (disputed):** lock → accept → deliver → the buyer disputes at 50% → `settle` pays the seller the 50% price and returns the rest to the buyer at once.
- **Run D (not accepted):** lock → the seller never accepts → accept-by passes → `refund` returns the cap to the buyer.
- **Run E (not delivered):** lock → accept → the seller never delivers → deliver-by passes → `refund` returns the cap to the buyer.

Each run starts with a fresh quote. The seller signs its quote hash, the buyer checks the hash and signature, and the contract checks both again at lock.

The buyer and seller hold only USDC, with 0 XLM. They sign Soroban auth entries and nothing else. AgentKred submits their calls from a channel account inside a fee-bump, and it sponsors their account and trustline reserves. `settle` and `refund` are called by an unrelated third account, which shows that anyone can close an escrow.

After each run closes, the script reads the contract's `escrow_settled` or `escrow_refunded` event from the closing transaction and prints the work record built from it. The record shows the outcome, the buyer and seller, the asset, the cap and floor, the completeness, the amount paid to the seller and the amount returned to the buyer. It also gives the payment reference (escrow id plus the settle or refund transaction), the quote and manifest hashes, and each clock as set and as met.

When the run finishes, the script writes an evidence file to `evidence/`. It contains the contract ID, the WASM hash, every transaction hash with an explorer link, and the five work records.

## Prerequisites

- Rust with the `wasm32v1-none` target, plus the Stellar CLI
- Node.js 20 or later
- A browser to fund the buyer at [faucet.circle.com](https://faucet.circle.com)

## Running it

The demo keeps its state in two files:

- `.demo/state.json` is committed. It records the public addresses of every account, the deployed contract and the setup transactions.
- `.demo/secrets.json` is gitignored. It holds the matching testnet secret keys and never leaves your machine.

A fresh clone has no keys, so it sets up its own accounts and contract. Run these from the repository root:

```sh
npm install
cd examples/cli-demo
npm run build:contract
npm run setup
```

`setup` takes care of everything before the demo can run:

- Generates a keypair per role when `.demo/secrets.json` doesn't exist yet. It saves the keys there and the public addresses to `.demo/state.json`. Delete `secrets.json` to start from scratch.
- Funds AgentKred's accounts with Friendbot.
- Opens the buyer and seller as zero-XLM accounts with USDC trustlines.
- Deploys the contract with AgentKred's fee account as its admin, or upgrades it in place if it is already deployed.

At the end it prints the buyer's address.

Next, fund the buyer with at least 3 testnet USDC from [faucet.circle.com](https://faucet.circle.com): choose Stellar Testnet and paste the buyer's address. Then run:

```sh
npm run demo
```

The run takes about six minutes. Run it again whenever you like. Each run locks 1 USDC five times and spends 2.6: runs A and B each pay 1 to the seller, run C pays 0.6, and runs D and E refund the buyer in full. After you change the contract, bump `version()`, rebuild it and run `npm run setup` again. It uploads the new WASM and upgrades the deployed contract in place, so the contract ID and existing escrows stay the same. If the change alters the stored escrow struct, let every open escrow close first. Upgrades are a testnet-only feature: the admin and the upgrade function will be removed before mainnet. To deploy a brand-new contract instead, run `npm run setup -- --redeploy`.

## Settings

The quoted terms are set in [src/config.ts](src/config.ts): a 1 USDC cap, a 0.2 USDC floor, a schedule paying 0.2 at 0%, 0.6 at 50% and 1 at 100%, and clocks of 45s to accept, 60s to deliver and 60s to dispute.

`npm test` runs the quote encoder's tests, including the quote-hash vector the contract's Rust tests also assert. Set `AGENTKRED_RPC_URL` to use a different testnet RPC endpoint.
