# @agentkred/shared

Code shared by the AgentKred server, the buyer SDK, the seller middleware and the demo.

| Export | What it does |
| --- | --- |
| `Chain` | Reads accounts, USDC and XLM balances, ledger time and transaction results from a Stellar RPC endpoint |
| `Submitter` | Simulates and submits transactions. `sponsored` sends a party's contract call from a channel account inside a fee-bump, so the party signs only its Soroban auth entry and needs no XLM |
| `EscrowClient` | Calls the escrow contract (`lock`, `accept`, `deliver`, `acknowledge`, `dispute`, `settle`, `refund`), reads escrows and parses the settle or refund event that closed one |
| `Quotes` | Encodes `QuoteTerms` exactly as the contract does, hashes them, and signs and verifies the seller's quote signature |
| `WorkRecords` | Builds a work record from a closed escrow and its terminal event |
| `EscrowEvents` | Decodes the contract's events into typed objects |
| `AuthEntries` | Signs a contract call tree as a Soroban auth entry without simulating, and reads one back: who signed which call |
| `Listings` | Signs and verifies a seller's listing with its pay-to key |
| `Manifests` | Computes the manifest hash a seller passes to `deliver` |
| `Webhooks` | Signs and verifies AgentKred's webhook bodies |
| `TESTNET`, `NetworkConfig` | Network settings every client is built from |
| `ESCROW_ERRORS`, `SimulationError` | The contract's error names, and the contract error code carried by a failed simulation |

Build a client from network settings:

```ts
import { Chain, EscrowClient, Submitter, TESTNET } from "@agentkred/shared";

const chain = new Chain(TESTNET);
const submitter = new Submitter(chain);
const escrow = new EscrowClient(contractId, submitter, { channel, fees });
```

Run `npm test` to run the tests. They include the quote-hash vector that the contract's Rust tests also check.
