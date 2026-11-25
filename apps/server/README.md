# AgentKred server

The AgentKred coordinator. It takes buyers' locks and sellers' and buyers' calls, checks them, and submits them to the escrow contract with AgentKred paying the fee. It keeps a Postgres journal of every escrow and sends signed webhooks for every transition. The routes are in [docs/api.md](../../docs/api.md) and the journal in [docs/journal.md](../../docs/journal.md).

## Running it locally

You need Node.js 20 or later and Docker.

```sh
npm install
cd apps/server
cp .env.example .env     # then fill in CHANNEL_SECRET and FEE_SECRET
npm run db:up            # Postgres on port 5433
npm run db:migrate
npm start                # the API, on port 8080
npm run worker           # in a second terminal: event ingestion and webhooks
```

`CHANNEL_SECRET` and `FEE_SECRET` are AgentKred's operator accounts: one sends each call and the other pays the fee-bump. They only ever hold XLM. On testnet, the cli-demo's `fees` and `channel` keys in `examples/cli-demo/.demo/secrets.json` work.

## Tests

```sh
npm test               # unit tests, then the database tests against the local test database
npm run test:testnet   # the coordinator on testnet; needs .env and the cli-demo's funded accounts
```

The testnet suite locks two escrows from the demo buyer and spends 1.6 USDC. It also checks that each rejected lock gets the right 4xx, that every webhook arrives signed, and that the rebuilt journal matches the chain.
