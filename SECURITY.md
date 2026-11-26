# Security Policy

AgentKred moves real funds through a Soroban escrow contract, so we take vulnerability reports seriously and ask that you disclose them privately.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub instead:

1. Go to the [Security tab](https://github.com/devasignhq/agentkred/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected component, and the steps to reproduce it. A proof of concept against testnet is very welcome.

We will confirm we received your report, keep you updated while we investigate, and credit you in the advisory once a fix ships, unless you'd rather stay anonymous.

## Scope

In scope:

- **Escrow contract** (`contracts/escrow/`): anything that lets funds move outside the rules fixed at lock time. Examples include paying out above the cap or below the floor, settling or refunding early, bypassing a signed quote, replaying an authorization, or locking funds so they can never be settled or refunded.
- **AgentKred service** (`apps/server/`): anything that would let the service move user funds, forge or alter work records, or submit transactions a buyer or seller did not authorize.
- **Buyer SDK, seller middleware and shared package** (`packages/`): flaws in quote, signature, manifest or authorization checks that would make a client accept something it should reject.
- **MCP server** (`apps/mcp/`) and the catalog: injection, or manipulation of rankings and work records.

Out of scope:

- The testnet-only upgrade admin on the escrow contract. It is a known, documented capability that will be removed before mainnet.
- Testnet keys and accounts used by `examples/cli-demo`. They hold only testnet assets.
- Denial-of-service against public testnet infrastructure that AgentKred does not operate.
- Findings that need a compromised buyer or seller key.

## Supported versions

AgentKred is pre-release and deployed on Stellar testnet only. Fixes land on `main`; there are no maintained release branches yet.
