---
title: Safe x402 agent with Cloudflare Agents
slug: safe-x402-agent-with-cloudflare-agents
date: 2026-05-05
audience: developers building x402-paying agents on the Cloudflare Agents platform
estimated_setup: 5 minutes
---

# Safe x402 agent with Cloudflare Agents

Cloudflare Agents (the platform behind `agents-sdk` + `Workers AI Gateway` + `vectorize`) supports outbound paid HTTP via the standard fetch API. When your agent calls an x402 endpoint, the request goes through `wrapFetchWithPaymentFromConfig` (or your equivalent) and signs `PAYMENT-SIGNATURE` against the wallet you've bound.

[Cloudflare's own agent-readiness scanner](https://isitagentready.com/) has flagged endpoint trust as one of the top open problems — agents on Workers can't easily tell whether a paid x402 URL is real, slow, or a [$1,000–$500,000 honeypot](https://x402station.io/blog/x402-honeypot-zone-5x-in-60-days). This recipe wraps the agent's fetch in `x402station-middleware` (Guard) so a `preflight` check runs before every `PAYMENT-SIGNATURE`. Fail-closed by default.

## What you need

- A Cloudflare Workers project with the Agents SDK or any compatible runtime that exposes `fetch`.
- A Base mainnet wallet held by the agent with a small USDC balance (≥ $0.10 covers ~10,000 preflight calls if you buy bulk credits).
- `wrangler` configured. 5 minutes.

## Install

```bash
npm install x402station-middleware @x402/fetch @x402/evm viem
```

`x402station-middleware` is pure ESM and works in the Workers runtime. No Node-only dependencies.

## Wrangler config — secret binding

Put the agent's private key in a Workers secret, never in `wrangler.toml`:

```bash
wrangler secret put AGENT_PRIVATE_KEY
# paste the 0x-prefixed private key
```

If you want to use bulk credits ($0.50 = 1000 prepaid preflights):

```bash
wrangler secret put X402STATION_CREDIT_ID
# paste the creditId returned by POST /api/v1/credits
```

Or store it in a KV namespace if you'll rotate it programmatically.

## The agent file

```ts
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { wrapWithPreflight } from "x402station-middleware";

export interface Env {
  AGENT_PRIVATE_KEY: string;
  X402STATION_CREDIT_ID?: string;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY as `0x${string}`);

    const x402Fetch = wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [
        { network: "eip155:8453",  client: new ExactEvmScheme(account) },
        { network: "eip155:84532", client: new ExactEvmScheme(account) },
      ],
    });

    const safeFetch = wrapWithPreflight(x402Fetch, {
      creditId: env.X402STATION_CREDIT_ID,
      // Defaults: blocks dead / zombie / decoy_price_extreme / never_paid_zombie /
      // dead_7d / mostly_dead. fail-closed on preflight unreachable.
    });

    // Now use `safeFetch` for any x402 endpoint your agent reaches.
    // This is the entire safety integration — one wrap, no other config.
    const targetUrl = new URL(req.url).searchParams.get("target");
    if (!targetUrl) return new Response("missing ?target", { status: 400 });

    try {
      const upstream = await safeFetch(targetUrl, { method: "POST", body: req.body });
      return new Response(await upstream.text(), { status: upstream.status });
    } catch (e) {
      if ((e as Error).name === "PreflightBlockedError") {
        // Guard refused to sign. Body of the error includes the warnings array
        // and the suggested recommended_action (typically "use_alternatives").
        return new Response(JSON.stringify({ error: "blocked_by_guard", detail: (e as Error).message }), {
          status: 403, headers: { "content-type": "application/json" },
        });
      }
      throw e;
    }
  },
};
```

## Edge cases the Workers runtime adds

- **No long-lived connections.** Workers don't keep TCP across requests by default. The default 5-minute TTL cache in `wrapWithPreflight` is per-request-scope, so a Worker that makes 10 paid calls to the same endpoint within one invocation gets one preflight cost; across invocations, each cold start re-validates. To share the cache across invocations, write the preflight verdict into KV with a short TTL (≤ 2 min) keyed on the URL.
- **CPU time limit.** Preflight adds one extra outbound HTTP call (~80–200 ms typical to `x402station.io` from Cloudflare's network). Budget accordingly.
- **EIP-712 signing in workers.** `viem`'s `privateKeyToAccount` runs in Workers without polyfills. No `node:crypto` dependency required.
- **`fetch` shadowing.** Don't shadow the `fetch` global with `safeFetch` — Workers internally use `fetch` for non-x402 calls (Workers AI, Vectorize, KV). Keep `safeFetch` named explicitly and only use it for x402-bound URLs.

## With Durable Objects

If your agent state lives in a Durable Object, the same pattern applies — bind `AGENT_PRIVATE_KEY` to the DO and instantiate `safeFetch` once in `constructor()`:

```ts
export class AgentDO {
  private safeFetch: typeof fetch;

  constructor(private state: DurableObjectState, env: Env) {
    const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY as `0x${string}`);
    const x402Fetch = wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }],
    });
    this.safeFetch = wrapWithPreflight(x402Fetch, {
      creditId: env.X402STATION_CREDIT_ID,
    });
  }

  async paidCall(url: string, body: unknown) {
    return this.safeFetch(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }
}
```

Each DO instance gets its own preflight cache, scoped to that user's agent.

## Test against a known decoy

```bash
# Pull one current decoy URL (this curl itself is a paid call: $0.005 USDC).
curl -sS -X POST https://x402station.io/api/v1/catalog/decoys \
  -H 'content-type: application/json' \
  --header "PAYMENT-SIGNATURE: <your-signed-header>" \
  -d '{}' | jq '.entries[0].url'
```

Hit your Worker with that URL as `?target=`. Expect `403 blocked_by_guard` instead of an attempted payment to the decoy.

## Rollout checklist

- [ ] `npm install x402station-middleware @x402/fetch @x402/evm viem`
- [ ] `wrangler secret put AGENT_PRIVATE_KEY` (Base mainnet wallet, ≥ $0.10 USDC)
- [ ] (Optional) `wrangler secret put X402STATION_CREDIT_ID`
- [ ] `wrapWithPreflight(x402Fetch)` initialised once per Worker / DO
- [ ] `safeFetch` used for every x402 outbound; `fetch` reserved for Workers AI / KV / Vectorize
- [ ] Test invocation against a known-decoy URL → confirmed `PreflightBlockedError` → 403 to caller
- [ ] (Optional) KV cache warm-path for the 5-min preflight TTL across invocations

## Source links

- npm: [`x402station-middleware`](https://www.npmjs.com/package/x402station-middleware)
- API docs: [https://x402station.io/api](https://x402station.io/api)
- OpenAPI: [https://x402station.io/api/openapi.json](https://x402station.io/api/openapi.json)
- Cloudflare Agents: [developers.cloudflare.com/agents](https://developers.cloudflare.com/agents/)
- Reach the team: [hello@x402station.io](mailto:hello@x402station.io)
