# Escrow contract

The contract in [contracts/escrow](../contracts/escrow) holds the cap for one job at a time. The buyer locks a quote the seller signed, and from then on the contract runs the job on three clocks fixed by that quote. If the seller misses the accept or deliver deadline, the buyer is refunded. If the seller delivers, the escrow settles by the payout schedule: the full cap on an acknowledgement or a silent dispute window, or the quoted price for the completeness the buyer disputed at.

## Testnet deployment

| | |
| --- | --- |
| Contract ID | `CAHINXFZT6KHRRPRSZ7YN5VN75QS7KBGW5NKW5QBKJV6ZIN2IROQFFVM` ([explorer](https://stellar.expert/explorer/testnet/contract/CAHINXFZT6KHRRPRSZ7YN5VN75QS7KBGW5NKW5QBKJV6ZIN2IROQFFVM)) |
| WASM hash | `96a64e11f83a89ca229a1c38fb8267568b1c9105038d4dfd492aab7be9795919` |
| Version | 2 |
| Asset | Circle testnet USDC, `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

## The quote

The seller's signed quote is a `QuoteTerms` struct:

| Field | Type | Meaning |
| --- | --- | --- |
| `seller` | address | The seller's pay-to account (a `G…` address) |
| `asset` | address | The token contract the cap is paid in |
| `cap` | i128 | The most the buyer can pay, locked in full |
| `floor` | i128 | The least the seller is paid once it delivers |
| `schedule` | `Vec<PayoutStep>` | What the seller is paid at each completeness percentage |
| `accept_s` | u64 | Seconds the seller has to accept, counted from the lock |
| `deliver_s` | u64 | Seconds the seller has to deliver, counted from acceptance |
| `dispute_s` | u64 | Seconds the buyer has to acknowledge or dispute, counted from delivery |
| `job_id` | bytes32 | The seller's id for this job |

The **quote hash** is `sha256` of the XDR encoding of the `QuoteTerms` value: an `ScMap` with the field names as symbol keys in sorted order, and each `PayoutStep` encoded the same way. The seller signs the 32-byte quote hash with the ed25519 key of its `seller` account. `quote_hash(terms)` returns the hash the contract computes, so a client can check its own encoding against it. The test vector in `quote_hash_matches_the_cross_language_vector` is asserted by both the Rust tests and [the TypeScript encoder's tests](../examples/cli-demo/tests/quote.test.ts).

The signature is checked against the seller account's master key. If an account has disabled its master key, quotes it signs with that old key still verify. That doesn't let anyone else put the seller to work: `accept` and `deliver` need the seller's real account authorization, and an escrow the seller never accepts is refunded at accept-by.

### Payout schedule

Each `PayoutStep` is `{ completeness: u32, payout: i128 }`, with completeness as a whole percentage from 0 to 100. `lock` refuses a schedule unless:

- its last step is `100 → cap`, and every other step pays less than the cap
- completeness rises strictly from step to step, and the payout never falls
- every payout is between the floor and the cap
- when the floor is below the cap, its first step is `0 → floor`, so a buyer who can't use the artifact at all can dispute at 0 and pay only the floor
- when the floor equals the cap, it is only `100 → cap`; disputes are then rejected and the escrow always settles at the cap

An acknowledgement, or a dispute window that closes in silence, settles at completeness 100. A dispute settles at the completeness the buyer named, which must be a step in the schedule below 100.

## Functions

| Function | Caller | Precondition | Effect |
| --- | --- | --- | --- |
| `lock(buyer, terms, quote_hash, seller_sig)` | Buyer, through one auth entry that also covers the token transfer | `sha256(xdr(terms)) == quote_hash`; `seller_sig` is the seller's signature over `quote_hash`; `cap > 0`; `0 ≤ floor ≤ cap`; each clock is between 1s and 30 days; buyer ≠ seller; the schedule is valid | Moves the cap from the buyer into the contract, stores every term and sets `accept_by = now + accept_s`. State becomes `Locked`. Returns the escrow id |
| `accept(escrow_id)` | Seller | State is `Locked` and `now < accept_by` | Sets `deliver_by = now + deliver_s`. State becomes `Accepted` |
| `deliver(escrow_id, manifest_hash)` | Seller | State is `Accepted` and `now < deliver_by` | Stores the manifest hash and sets `dispute_by = now + dispute_s`. State becomes `Delivered` |
| `acknowledge(escrow_id)` | Buyer | State is `Delivered` and `now < dispute_by` | State becomes `Acknowledged` |
| `dispute(escrow_id, completeness)` | Buyer | State is `Delivered`, `now < dispute_by`, and `completeness` is a schedule step below 100 | Stores the completeness. State becomes `Disputed` |
| `settle(escrow_id)` | Anyone | State is `Acknowledged` or `Disputed`, or `Delivered` with `now ≥ dispute_by` | Pays the seller the schedule price for the final completeness and returns the rest to the buyer. State becomes `Released`. Returns the payout |
| `refund(escrow_id)` | Anyone | State is `Locked` with `now ≥ accept_by`, or `Accepted` with `now ≥ deliver_by` | Returns the cap to the buyer. State becomes `Refunded`. Returns the amount |
| `get_escrow(escrow_id)` | Anyone | The escrow exists | Returns the stored escrow |
| `quote_hash(terms)` | Anyone | | Returns the quote hash of `terms` |

```
Locked ──accept──▶ Accepted ──deliver──▶ Delivered ──acknowledge──▶ Acknowledged ──settle──▶ Released
  │                   │                     ├──dispute──▶ Disputed ──settle──▶ Released
  │                   │                     └──(dispute_by passes)──settle──▶ Released
  └─(accept_by)─┐     └─(deliver_by)─┐
                ▼                    ▼
             refund ──▶ Refunded ◀── refund
```

Before paying out, `settle` checks the payout gate again: `floor ≤ payout ≤ cap`, and a disputed payout is strictly below the cap. The amounts paid to the seller and returned to the buyer always add up to the cap.

All deadlines are compared against ledger time, never against a time passed in by the caller. Each deadline is set once, by the transition that starts its clock, and never changes. `lock` extends the escrow's storage TTL past its latest possible deadline (`accept_s + deliver_s + dispute_s` after the lock), plus about one day, so an untouched escrow can't be archived before it closes.

The contract is deployed with one constructor argument, `admin`, the address allowed to upgrade it on testnet.

## Admin and upgrades (testnet only)

On testnet the contract has an admin who can upgrade its code in place, so a change doesn't need a redeploy. The contract ID, every escrow and every balance stay the same; only the code changes. **The admin and the upgrade function will be removed before mainnet**, and the mainnet contract will have no admin.

| Function | Caller | Effect |
| --- | --- | --- |
| `upgrade(new_wasm_hash)` | Admin | Replaces the contract's code with an already uploaded WASM and emits `contract_upgraded` |
| `set_admin(new_admin)` | Admin | Hands the admin role to `new_admin` |
| `get_admin()` | Anyone | Returns the current admin |
| `version()` | Anyone | Returns the contract version. It is bumped with every upgrade |

To release a change, bump `version()`, rebuild, and run `npm run setup` in [examples/cli-demo](../examples/cli-demo). Setup uploads the new WASM and calls `upgrade`. An upgrade that changes the stored `Escrow` struct can't read escrows written under the old shape, so close every open escrow before releasing one.

## Events

Each escrow event takes `escrow_id` as a topic. Every escrow emits exactly one terminal event, `escrow_settled` or `escrow_refunded`, and work records are built from it.

| Event | Data |
| --- | --- |
| `escrow_locked` | buyer, seller, asset, cap, floor, job id, quote hash, accept-by |
| `escrow_accepted` | deliver-by |
| `escrow_delivered` | manifest hash, dispute-by |
| `escrow_acknowledged` | buyer |
| `escrow_disputed` | buyer, completeness |
| `escrow_settled` | buyer, seller, outcome (`Acknowledged`, `Silent` or `Disputed`), completeness, payout, remainder |
| `escrow_refunded` | buyer, reason (`NotAccepted` or `NotDelivered`), amount |
| `contract_upgraded` | new WASM hash, admin (no escrow id topic) |

## Errors

| Code | Name | Raised when |
| --- | --- | --- |
| 1 | `EscrowNotFound` | No escrow exists with that id |
| 2 | `InvalidCap` | The cap is zero or negative |
| 3 | `InvalidDuration` | A clock is zero or longer than 30 days |
| 4 | `SameParty` | The buyer and seller are the same address |
| 5 | `WrongState` | The call doesn't fit the escrow's current state |
| 6 | `DeliverDeadlinePassed` | `deliver` is called at or after deliver-by |
| 7 | `DeliverDeadlineNotPassed` | `refund` is called on an accepted escrow before deliver-by |
| 8 | `DisputeWindowOpen` | `settle` is called on an unanswered delivery before dispute-by |
| 9 | `DisputeWindowClosed` | `acknowledge` or `dispute` is called at or after dispute-by |
| 10 | `QuoteHashMismatch` | The terms passed to `lock` don't hash to the quote hash |
| 11 | `InvalidSeller` | The seller is not an account address, so it has no key to sign quotes |
| 12 | `InvalidFloor` | The floor is negative or above the cap |
| 13 | `InvalidSchedule` | The payout schedule breaks one of the rules above |
| 14 | `CompletenessNotInSchedule` | `dispute` names a completeness that isn't a schedule step below 100 |
| 15 | `AcceptDeadlinePassed` | `accept` is called at or after accept-by |
| 16 | `AcceptDeadlineNotPassed` | `refund` is called on a locked escrow before accept-by |
| 17 | `PayoutOutOfRange` | `settle` computed a payout outside the gate |

A seller signature that doesn't verify aborts `lock` with the host's crypto error rather than a contract error code.

## Building and testing

```sh
cargo test
stellar contract build --package agentkred-escrow
```

`cargo test` runs the unit tests and the property tests in [props.rs](../contracts/escrow/src/props.rs). The property tests drive random schedules and random call sequences at random ledger times. After every call they check that no deadline moves. At the end they check that the escrow can always be closed, that it emits exactly one terminal event, and that the payout stays inside the gate with the cap conserved. They also check that changing any signed term fails the quote hash check.

The fuzz target in [contracts/escrow/fuzz](../contracts/escrow/fuzz) checks the same invariants with `cargo-fuzz`. It needs nightly Rust on Linux or macOS:

```sh
cd contracts/escrow
cargo +nightly fuzz run lifecycle -- -max_total_time=300
```

CI ([.github/workflows/contract.yml](../.github/workflows/contract.yml)) runs the tests, the quote-hash vector, a five-minute fuzz run, and `cargo llvm-cov`. It publishes the coverage summary on the run page and the full report as an artifact.

To deploy the contract and drive all five outcomes on testnet, see [examples/cli-demo](../examples/cli-demo).
