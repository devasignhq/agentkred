# Escrow journal

The journal is the server's Postgres record of every escrow. The chain stays the source of truth. The journal is a copy the server can query, rebuild and check against it.

## What it stores

| Table | Holds | Changes |
| --- | --- | --- |
| `chain_events` | Every event the escrow contract emitted, as raw XDR with its ledger and transaction | Append only |
| `escrows` | One row per `escrow_locked` event: the terms the escrow opened with | Append only |
| `escrow_transitions` | One row per escrow event, with the state it moved to and the clocks or amounts it set | Append only |
| `ingest_cursor` | How far the contract's events have been read | Moves forward |
| `sellers` | Seller listings | Updated by newer signed listings |
| `quotes` | Quotes locked through the server, with the buyer's webhook | Written at lock |
| `manifests`, `disputes` | What the seller delivered and the buyer's dispute evidence | Written when posted |
| `chain_transactions` | Every call the server submitted, and its outcome | Pending, then succeeded or failed |
| `webhook_deliveries` | Each webhook to each recipient, its attempts and outcome | Until delivered or given up |

An escrow's current state is its latest transition. Nothing that mirrors the chain is ever edited in place.

## How events get in

The ingestor polls the RPC's `getEvents` for the escrow contract, starting from the saved cursor. Each new event is appended to `chain_events` and projected into `escrows` and `escrow_transitions` in the same database transaction. A Postgres advisory lock lets only one ingestor run at a time, and inserts are keyed on the RPC's event id, so reading an event twice changes nothing.

The worker (`npm run worker`) ingests every couple of seconds. The API also ingests after each call it submits and waits until the journal has read that ledger, so a response always shows the call's effect. Calls made straight to the contract, such as a `settle` from any account, appear on the worker's next poll.

The RPC only keeps about 7 days of events. On a fresh database the ingestor starts at `INGEST_START_LEDGER`, or at the oldest ledger the RPC still holds. Events for escrows locked before that point are stored but not projected.

## Rebuilding and verifying

```sh
npm run journal:rebuild
npm run journal:verify
```

`journal:rebuild` deletes `escrows` and `escrow_transitions` and re-projects every stored event in chain order. It sends no webhooks.

`journal:verify` catches the journal up, then compares three things:

- the live projection
- an in-memory replay of the stored events
- every escrow's `get_escrow` on chain

It prints each field that disagrees and exits with 1 if anything does. A healthy journal reports `0 divergences`.
