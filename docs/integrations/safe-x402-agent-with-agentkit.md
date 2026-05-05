---
title: Safe x402 agent with Coinbase AgentKit
slug: safe-x402-agent-with-agentkit
date: 2026-05-05
audience: developers building x402-paying agents on Coinbase AgentKit
estimated_setup: 4 minutes
---

# Safe x402 agent with Coinbase AgentKit

By default an AgentKit agent that uses `@x402/fetch` will sign payment for any endpoint the model decides to call. That includes [endpoints listed at $1,000–$500,000 USDC per call](https://x402station.io/blog/x402-honeypot-zone-5x-in-60-days), zombie services that 100% error after settlement, and endpoints with zero successful payments ever (`never_paid_zombie`).

This recipe wraps the agent's fetch in `x402station-middleware` (Guard) so a `preflight` check runs before every `PAYMENT-SIGNATURE`. Fail-closed by default — the agent refuses to sign on critical signals (`dead`, `zombie`, `decoy_price_extreme`, `never_paid_zombie`, `dead_7d`, `mostly_dead`) and only signs after Guard says `ok: true`.

## What you need

- An AgentKit project (TypeScript/Node, `@coinbase/agentkit` or the standalone `coinbase-agentkit-core` package).
- A Base mainnet wallet held by the agent with a small USDC balance (≥ $0.10 covers ~10,000 preflight calls if you buy bulk credits).
- 4 minutes.

## Install

```bash
npm install x402station-middleware @x402/fetch @x402/evm viem
# or: bun add x402station-middleware @x402/fetch @x402/evm viem
```

## Wire it up

Wherever your agent currently builds its `fetch` for x402 payments, wrap it with `wrapWithPreflight`:

```ts
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { wrapWithPreflight } from "x402station-middleware";

// Your agent's wallet (the one signing payments — distinct from any Coinbase
// CDP key the AgentKit harness uses to read balances or run wallet ops).
const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);

// Standard @x402/fetch wrapper — handles 402 retries + EIP-712 signing.
const x402Fetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    { network: "eip155:8453",  client: new ExactEvmScheme(account) },  // Base mainnet
    { network: "eip155:84532", client: new ExactEvmScheme(account) },  // Base Sepolia (test)
  ],
});

// One-line shielding. Preflight runs before every payment, fail-closed by default.
const safeFetch = wrapWithPreflight(x402Fetch);

// Use exactly like fetch.
const res = await safeFetch("https://api.example.com/x402-endpoint", {
  method: "POST",
  body: JSON.stringify({ ... }),
});
// ↑ throws PreflightBlockedError if the endpoint is dead / zombie / decoy /
//   never_paid_zombie. Catches before the wallet ever signs.
```

## Plug into AgentKit

If your AgentKit setup uses an `EvmWalletProvider`, wire `safeFetch` into the action provider that runs paid x402 calls:

```ts
import { EvmWalletProvider } from "@coinbase/agentkit";

class X402PayingActionProvider {
  constructor(private wallet: EvmWalletProvider, private fetcher: typeof fetch) {}

  // Action-provider methods call this.fetcher(...) instead of bare fetch.
  // Pass `safeFetch` (above) into the constructor.
}

const actionProvider = new X402PayingActionProvider(wallet, safeFetch);
```

If you'd rather wire Guard at the AgentKit-action-provider layer (one-stop x402-tools for the agent), use the `x402station` action provider in [PR #1154 against `coinbase/agentkit`](https://github.com/coinbase/agentkit/pull/1154) (also available as a fork-snapshot in `contrib/coinbase-agentkit-x402station/`). Tools: `preflight`, `forensics`, `catalog_decoys`, `alternatives`, `whats_new`, `watch_subscribe`, `buy_credits`, `credits_status`, `watch_status`, `watch_unsubscribe`. Wallet binding via `EvmWalletProvider` — same AGENT_PRIVATE_KEY pattern, no new credentials.

## Bulk credits — drop preflight cost 50%

By default each preflight is `$0.001` (CDP minimum). If your agent makes many paid calls, buy a credit bundle once:

```ts
// One-time setup somewhere in your agent boot, or run once via curl/script
// and store the creditId in your agent's KV.
const creditRes = await safeFetch("https://x402station.io/api/v1/credits", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
});
const { creditId } = await creditRes.json();
// $0.50 → 1000 prepaid preflights → $0.0005/call effective.

// Pass creditId on every preflight call:
const safeFetch = wrapWithPreflight(x402Fetch, { creditId });
```

When the bundle exhausts or expires (90 days), Guard automatically falls through to per-call x402 — no code change.

## Override behaviour (rare)

```ts
// Allow specific signals through (e.g. you accept slow endpoints):
const safeFetch = wrapWithPreflight(x402Fetch, {
  block: ["dead", "zombie", "decoy_price_extreme", "never_paid_zombie"],
  // omits "slow", "new_provider", etc. — those become warnings only
});

// Fail-open if preflight is unreachable (NOT recommended for production):
const safeFetch = wrapWithPreflight(x402Fetch, { failOpen: true });

// Set per-instance TTL cache (default 5 min) — preflight result is reused
// for the same URL within the window:
const safeFetch = wrapWithPreflight(x402Fetch, { cacheTtlMs: 60_000 });
```

## Test it locally

The decoy catalog has a few high-confidence honeypots you can use as test cases without spending real money on a bad payment (Guard refuses before payment). Pull one:

```bash
curl -sS -X POST https://x402station.io/api/v1/catalog/decoys \
  -H 'content-type: application/json' \
  -d '{}' | jq '.entries[0]'
# (this curl itself is a paid call: $0.005 USDC — buy a credit bundle if running this often)
```

Pass that URL to `safeFetch` and you should see `PreflightBlockedError` with `reasons: ["decoy_price_extreme"]` (or whatever signal fires).

## Rollout checklist

- [ ] `npm install x402station-middleware @x402/fetch @x402/evm viem`
- [ ] Wallet has Base mainnet USDC balance (≥ $0.10)
- [ ] `wrapWithPreflight(x402Fetch)` wraps every fetch the agent uses for x402 calls
- [ ] AgentKit action provider passes `safeFetch` instead of `fetch` to the x402-paying tool
- [ ] (Optional) Bulk credits purchased; `creditId` in agent KV
- [ ] Logged a test against a known-decoy URL; confirmed `PreflightBlockedError` thrown before settlement

## Source links

- npm: [`x402station-middleware`](https://www.npmjs.com/package/x402station-middleware)
- AgentKit fork: [`sF1nX/agentkit` PR #1154](https://github.com/coinbase/agentkit/pull/1154) (preserved snapshot in `contrib/coinbase-agentkit-x402station/`)
- API docs: [https://x402station.io/api](https://x402station.io/api)
- OpenAPI: [https://x402station.io/api/openapi.json](https://x402station.io/api/openapi.json)
- Reach the team: [hello@x402station.io](mailto:hello@x402station.io)
