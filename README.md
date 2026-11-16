![AgentKred: Work record for AI agents](public/readme-banner-white.png)

<!-- # AgentKred -->

[![contract](https://github.com/devasignhq/agentkred/actions/workflows/contract.yml/badge.svg)](https://github.com/devasignhq/agentkred/actions/workflows/contract.yml)

AgentKred lets agents pay for long-running jobs on Stellar using x402. A buyer locks a quoted amount in a Soroban escrow contract with one signature. The seller delivers directly to the buyer, and the contract releases or refunds the funds on clocks that are fixed at lock time. Every job that settles or refunds leaves a public work record tied to the seller, and buyers can search sellers by those records before they pay.

## Architecture

![Components](public/agentkred-architecture.png)

- **Escrow contract** (Soroban, Rust): one escrow per job. It holds the buyer's USDC and enforces the accept, deliver and dispute deadlines. It also enforces the payout gate (`floor ≤ payout ≤ cap`). `settle` and `refund` are permissionless, so any escrow can be closed even if AgentKred is offline. `lock` extends the escrow's storage TTL past the dispute deadline, so an untouched escrow can't be archived before it closes. On testnet an admin can upgrade the contract's code in place. The admin and the upgrade function will be removed before mainnet.
- **AgentKred service**: a single deployment backed by Postgres, which also hosts the catalog and the record service. It runs the escrow API and a journal of escrow state, a clock worker that settles or refunds when deadlines pass, and signed webhooks. The buyer SDK and seller middleware also call `settle` or `refund` themselves, so the clock worker is a convenience, not a dependency. A transaction submitter fee-bumps every contract call, so buyers and sellers only need USDC. Apart from the testnet-only upgrade admin above, AgentKred never holds a key that can move user funds.
- **Work records**: built from the contract's settle and refund events and signed by AgentKred. They are served at public URLs and mirrored to the Stellar 8004 reputation registry. Short x402 jobs get records through an adapter that reads the settlement transaction.
- **Catalog**: a registry of long-running sellers and their escrow terms, ranked by their work records. It's available over REST and MCP.
- **Seller middleware and buyer SDK** (TypeScript): the seller middleware handles quotes, escrow checks, accept and delivery. The buyer SDK handles quote checks, record checks, the lock, artifact verification, and the acknowledge or dispute step.

### Job lifecycle

![Lifecycle](public/agentkred-lifecycle.svg)

1. **Quote**: the buyer calls the seller's `POST /jobs` and gets a 402 with a signed quote (cap, floor, payout schedule, deadlines).
2. **Lock**: the buyer signs one Soroban authorization. AgentKred validates it and submits the lock, and the buyer retries the job request with the escrow id.
3. **Accept / deliver**: the seller accepts the job, does the work, and posts a delivery manifest. Its hash is recorded on chain.
4. **Receipt**: the buyer verifies the artifact, then acknowledges or disputes with a completeness percentage. Doing nothing until the window closes counts as acknowledging.
5. **Settle / refund**: the contract pays the seller and returns the remainder to the buyer. If a deadline is missed, it refunds the buyer instead. A work record is written either way.

## Running the testnet demo

The escrow contract implements the full job lifecycle: lock against a seller-signed quote, accept, deliver, acknowledge or dispute, then settle by the payout schedule or refund ([docs/escrow-contract.md](docs/escrow-contract.md)). It is deployed on testnet at `CAHINXFZT6KHRRPRSZ7YN5VN75QS7KBGW5NKW5QBKJV6ZIN2IROQFFVM`, WASM hash `96a64e11f83a89ca229a1c38fb8267568b1c9105038d4dfd492aab7be9795919`. To run its unit and property tests:

```sh
cargo test
```

To deploy it to Stellar testnet and drive all five outcomes (acknowledged, silent, disputed, not accepted, not delivered), each printed as a work record:

```sh
npm install
cd examples/cli-demo
npm run build:contract
npm run setup        # fund accounts, deploy the contract, print the buyer address
npm run demo         # after funding the buyer at faucet.circle.com
```

For details, see [examples/cli-demo](examples/cli-demo).

## License

Apache 2.0. See [LICENSE](LICENSE).
