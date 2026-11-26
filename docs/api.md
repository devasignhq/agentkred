# AgentKred API

The AgentKred server sits between buyers, sellers and the [escrow contract](escrow-contract.md). Buyers and sellers sign their own Soroban auth entries. The server checks each one, submits it from its own channel account inside a fee-bump, and records the result. It never holds a key that can move a buyer's or seller's funds, so `settle` and `refund` stay open to anyone and don't go through this API.

All bodies are JSON. Amounts are whole stroops as decimal strings (`"10000000"` is 1 USDC), byte fields are hex, and times are unix seconds.

## Sellers

A seller is identified by its pay-to account, the same `G…` address its quotes name as `seller`. Every listing is signed by that account's key, the key the contract checks quotes against.

### `POST /sellers`

Registers a listing, or updates one.

```json
{
    "listing": {
        "payTo": "GAHUI5…",
        "name": "Report writer",
        "capMin": "5000000",
        "capMax": "20000000",
        "acceptS": 300,
        "deliverS": 3600,
        "disputeS": 600,
        "webhookUrl": "https://seller.example/agentkred"
    },
    "signedAt": 1763400000,
    "signature": "…"
}
```

`signature` is the pay-to key's ed25519 signature, in hex, over `sha256("agentkred.listing.v1\n" + json)`. `json` is `{ "listing": …, "signedAt": … }` with keys sorted at every level and no whitespace. `Listings.sign` in `@agentkred/shared` builds it.

| Status | When |
| --- | --- |
| 201 | A new seller. The body includes `webhookSecret`, which is shown only this once |
| 200 | An update to an existing listing |
| 400 `invalid_request` | The body doesn't match the shape above, or `webhookUrl` breaks the [webhook URL rules](#webhook-urls) |
| 401 `bad_signature` | The pay-to key didn't sign this listing |
| 401 `stale_signature` | `signedAt` is more than 5 minutes from the server's clock |
| 409 `replayed_listing` | A listing signed at the same time or later is already stored |
| 422 `invalid_listing` | The cap range isn't `0 < capMin ≤ capMax < 2^63` |

### `GET /sellers/{payTo}`

Returns the listing, without the webhook secret, or 404 `seller_not_found`.

## Escrows

### `POST /escrows`

Locks a seller's quote. The buyer signs one auth entry covering `lock(buyer, terms, quote_hash, seller_sig)` with the USDC `transfer(buyer → contract, cap)` beneath it. `AuthEntries.sign` in `@agentkred/shared` signs such a call tree without a simulation.

```json
{
    "quote": { "terms": { … }, "quoteHash": "…", "signature": "…" },
    "auth": "<base64 SorobanAuthorizationEntry>",
    "buyerWebhookUrl": "https://buyer.example/agentkred"
}
```

`quote` is the quote's JSON form (`Quotes.toJson`). `buyerWebhookUrl` is optional and follows the [webhook URL rules](#webhook-urls). It is stored for this buyer only, so webhooks go to whichever buyer's lock actually lands.

Before paying any fee, the server checks the following and answers with the first that fails:

| Status | Code | Check |
| --- | --- | --- |
| 400 | `malformed_quote`, `malformed_auth` | The quote's byte fields and the auth entry decode |
| 422 | `unknown_seller` | The quote's seller has a listing |
| 422 | `forged_quote` | The terms hash to `quoteHash`, and the seller's key signed that hash |
| 422 | `wrong_asset` | The quote is paid in USDC |
| 422 | `cap_out_of_range` | The cap is inside the seller's listed range |
| 409 | `quote_already_locked` | No escrow was opened from this quote before |
| 422 | `mismatched_arguments` | The auth entry authorizes exactly this contract's `lock` with this buyer and quote, and exactly the cap's transfer beneath it |
| 422 | `auth_expired` | The auth entry stays valid for at least 3 more ledgers |

On success it answers **201** with `escrowId`, `escrow` (as `GET /escrows/{id}` returns it), the lock's `txHash`, and `buyerWebhookSecret` when a webhook URL was given. If the lock landed but the journal hasn't read it within 30 seconds, it answers **202** with the same fields and `escrow: null`. Read the escrow later with `GET /escrows/{id}`.

### Party calls

The seller and buyer each post their own signed auth entry for one call. The server checks that the right party signed it (403 `wrong_signer`), that it covers exactly the expected call (422 `mismatched_arguments`), and that it won't expire during submission (422 `auth_expired`). Each call answers **200** with the escrow's updated view. If the call landed but the journal hasn't read it within 30 seconds, it answers **202** with `{ pending: true, escrowId, txHash }`. The call still took effect, and a dispute's evidence is still stored. Read the escrow later with `GET /escrows/{id}` rather than posting again.

| Route | Caller | Body | Contract call |
| --- | --- | --- | --- |
| `POST /escrows/{id}/accept` | Seller | `{ auth }` | `accept(id)` |
| `POST /escrows/{id}/manifest` | Seller | `{ artifactSha256, evidenceUrl?, auth }` | `deliver(id, manifest_hash)` |
| `POST /escrows/{id}/acknowledge` | Buyer | `{ auth }` | `acknowledge(id)` |
| `POST /escrows/{id}/dispute` | Buyer | `{ completeness, evidenceUrl?, note?, auth }` | `dispute(id, completeness)` |

The manifest is `{ escrowId, artifactSha256, evidenceUrl }`. Its hash is `sha256("agentkred.manifest.v1\n" + json)`, with the same sorted-key JSON, and `Manifests.hash` computes it. The seller signs `deliver` with that hash, so the server can only record a manifest the seller actually delivered.

When the contract rejects a call, the server answers with the contract error's name in snake case: 404 for `escrow_not_found`, 409 for a wrong state or a deadline (for example `accept_deadline_passed`), and 422 for the rest. A rejection that isn't a contract error, such as a bad signature, is 422 `simulation_failed`.

### `GET /escrows/{id}`

Returns the escrow as the journal records it:

- the terms: buyer, seller, asset, cap, floor, job id and quote hash
- `state`
- every clock: `acceptBy`, `acceptedAt`, `deliverBy`, `deliveredAt`, `disputeBy`, `acknowledgedAt`, `disputedAt`, `closedAt`
- `manifestHash`, plus `manifest` when it was posted here
- `completeness` and `dispute` after a dispute
- `settlement` (`outcome`, `completeness`, `payout`, `remainder`) or `refund` (`reason`, `amount`) once it closes
- `schedule` when the quote was locked through this server
- `transitions`, each with its ledger and transaction hash

A seller checks this before starting work. The read comes only from the journal, so an escrow locked moments ago straight on the contract can answer 404 until the worker's next poll.

## Webhooks

Every escrow transition is sent to the seller's listed webhook. It also goes to the buyer when the buyer gave a webhook URL at lock. The types are `escrow.locked`, `escrow.accepted`, `escrow.delivered`, `escrow.acknowledged`, `escrow.disputed`, `escrow.settled` and `escrow.refunded`.

```json
{
    "id": "0024562…-0000000001",
    "type": "escrow.settled",
    "escrowId": "12",
    "ledger": 5799012,
    "txHash": "…",
    "occurredAt": 1763401234,
    "data": { "outcome": "Disputed", "completeness": 50, "payout": "6000000", "remainder": "4000000" }
}
```

Each request carries `AgentKred-Event-Id` and `AgentKred-Signature: t=<unix seconds>,v1=<hex>`. The signature is HMAC-SHA256 with your webhook secret over `<t>.<raw body>`. Check it with `Webhooks.verify(secret, rawBody, header, now)`, which also rejects signatures more than 5 minutes old. Use the event id to drop duplicates.

### Webhook URLs

Webhook URLs must use `https` and must not point at `localhost` or at a loopback, private, link-local, carrier-grade NAT, multicast or cloud metadata address. The server checks the URL when it is registered. It checks again on every send, against the addresses the host resolves to at that moment. It never follows redirects, so a 3xx counts as a failed attempt. For local development and tests only, `WEBHOOK_ALLOW_INSECURE=true` lifts these rules.

### Delivery

Any 2xx response counts as delivered. Otherwise the server retries after 30 seconds, doubling the wait up to an hour, and gives up 24 hours after the event. A webhook is never sent unsigned: if the recipient's secret can't be found, the delivery fails without a request. A missed webhook never loses information: `GET /escrows/{id}` always has the current state.
