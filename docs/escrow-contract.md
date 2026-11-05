# Escrow contract

The contract in [contracts/escrow](../contracts/escrow) is the minimal first version of the AgentKred escrow. It holds the cap for one job, and on deadlines fixed at lock time it either pays the cap to the seller or returns it to the buyer.

It covers lock, deliver, settle and refund. Accept, acknowledge, dispute, the floor and the completeness payout schedule are not in this version yet. That means a delivered escrow always settles for the full cap.

## Functions

| Function | Caller | Precondition | Effect |
| --- | --- | --- | --- |
| `lock(buyer, seller, asset, cap, deliver_s, dispute_s, quote_hash)` | Buyer (one auth entry, which also covers the token transfer) | `cap > 0`; both durations are between 1s and 30 days; buyer ≠ seller | Moves the cap from the buyer into the contract and sets `deliver_by = now + deliver_s`. State becomes `Locked`. Returns the escrow id |
| `deliver(escrow_id, manifest_hash)` | Seller | State is `Locked` and `now < deliver_by` | Stores the manifest hash and sets `dispute_by = now + dispute_s`. State becomes `Delivered` |
| `settle(escrow_id)` | Anyone | State is `Delivered` and `now ≥ dispute_by` | Pays the cap to the seller. State becomes `Released`. Returns the payout |
| `refund(escrow_id)` | Anyone | State is `Locked` and `now ≥ deliver_by` | Returns the cap to the buyer. State becomes `Refunded`. Returns the amount |
| `get_escrow(escrow_id)` | Anyone | The escrow exists | Returns the stored escrow |

All deadlines are compared against ledger time, never against a time passed in by the caller. `lock` extends the escrow's storage TTL past its latest possible dispute deadline, plus about one day.

## Events

Each event takes `escrow_id` as a topic.

| Event | Data |
| --- | --- |
| `escrow_locked` | buyer, seller, asset, cap, quote hash, deliver-by |
| `escrow_delivered` | manifest hash, dispute-by |
| `escrow_released` | seller, payout |
| `escrow_refunded` | buyer, amount |

## Errors

| Code | Name | Raised when |
| --- | --- | --- |
| 1 | `EscrowNotFound` | No escrow exists with that id |
| 2 | `InvalidCap` | The cap is zero or negative |
| 3 | `InvalidDuration` | A duration is zero or longer than 30 days |
| 4 | `SameParty` | The buyer and seller are the same address |
| 5 | `WrongState` | The call doesn't fit the escrow's current state |
| 6 | `DeliverDeadlinePassed` | `deliver` is called at or after deliver-by |
| 7 | `DeliverDeadlineNotPassed` | `refund` is called before deliver-by |
| 8 | `DisputeWindowOpen` | `settle` is called before the dispute window closes |

## Building and testing

```sh
cargo test
stellar contract build --package agentkred-escrow
```

To deploy the contract and drive it on testnet, see [examples/cli-demo](../examples/cli-demo).
