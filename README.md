# x402station — public consumer-side surface

Public client SDKs and examples for [x402station.io](https://x402station.io) — a pre-flight oracle for the x402 agentic-commerce network.

This repo is the **consumer-side** surface only. The oracle backend (probe pipeline, signal logic, ingest, internal stats history) lives in a private repo. What's here is everything an agent or framework needs to **call** the oracle.

```
.
├── package.json + src/index.ts   # x402station-mcp (npm) — MCP adapter
└── examples/
    ├── agentkit-action-provider/ # Drop-in @coinbase/agentkit action provider
    └── demo-shielded-agent.ts    # Standalone consumer-side demo
```

## What's the oracle?

The agentic.market catalog has 25,000+ x402 endpoints. A non-trivial fraction are honeypots:

- **Decoys** priced ≥ $1,000 USDC per call. An agent that pays one drains its wallet.
- **Zombies** that 402-handshake fine but always 4xx after settlement (the call-side payment goes through, the agent gets nothing).
- **Dead** endpoints that return network errors or 5xx every probe.
- **Price-jacked** endpoints whose listed price drifted 10× past the provider's group median.

x402station independently probes every active catalog endpoint every ~10 minutes (not facilitator-reported) so it surfaces what facilitator-only monitors miss. Calling `preflight` before each paid x402 request costs $0.001 USDC — typically **20× cheaper than the request the agent would otherwise lose to a decoy**.

Six tools, all priced in USDC on Base mainnet via x402:

| Tool | Cost | Description |
|---|---|---|
| `preflight` | $0.001 | `{ok, warnings[], metadata}` for any URL — fast safety check |
| `forensics` | $0.001 | 7-day uptime + latency p50/p90/p99 + decoy probability |
| `catalog_decoys` | $0.005 | Full known-bad list as one cacheable JSON |
| `watch_subscribe` | $0.01 | 30-day webhook subscription + 100 prepaid HMAC-signed alerts |
| `watch_status` | free* | Read-back: active/expired, alerts remaining, recent deliveries |
| `watch_unsubscribe` | free* | Soft-delete a watch |

\* Free actions are secret-gated by the 64-char hex secret returned from `watch_subscribe`.

## Install — MCP-speaking agents (Claude Code / Cursor / Windsurf / Continue)

```bash
npx -y x402station-mcp
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "x402station": {
      "command": "npx",
      "args": ["-y", "x402station-mcp"],
      "env": { "AGENT_PRIVATE_KEY": "0x..." }
    }
  }
}
```

The adapter signs payments with `AGENT_PRIVATE_KEY` (a wallet you control that holds Base mainnet USDC) and exposes the six tools above to your MCP client.

## Install — `@coinbase/agentkit` agents

PR open at [coinbase/agentkit#1154](https://github.com/coinbase/agentkit/pull/1154). Until merged, the source is in [`examples/agentkit-action-provider/`](./examples/agentkit-action-provider/) — drop it into your fork's `src/action-providers/x402station/` and wire as:

```typescript
import {
  AgentKit,
  CdpEvmServerWalletProvider,
  x402stationActionProvider,
} from "@coinbase/agentkit";

const agentKit = await AgentKit.from({
  walletProvider,
  actionProviders: [x402stationActionProvider()],
});
```

## Try it without an MCP client

[`examples/demo-shielded-agent.ts`](./examples/demo-shielded-agent.ts) is a standalone Bun script that exercises all six tools in a realistic flow: pull catalog blacklist → preflight a known-good URL → preflight a known decoy → forensics → subscribe a watch → check status → unsubscribe. Total cost on real mainnet: $0.018 USDC.

```bash
git clone https://github.com/sF1nX/x402station-mcp.git
cd x402station-mcp
bun install
PROBER_PRIVATE_KEY=0x... bun run examples/demo-shielded-agent.ts --prod
```

## Networks

- **Base mainnet** (`eip155:8453`) — production
- **Base Sepolia** (`eip155:84532`) — testing

## What's NOT in this repo

By design, the moat-critical parts of x402station — the probe scheduler, the SQL signal logic that classifies an endpoint as `dead` / `zombie` / `decoy_price_extreme` etc., the catalog ingest pipeline, the security audits, and the months of probe history — stay in a private repo. This repo is the SDK surface, not the oracle itself. The oracle lives at <https://x402station.io>.

## Discovery surfaces (machine-readable)

- Manifest: <https://x402station.io/.well-known/x402>
- A2A agent card: <https://x402station.io/.well-known/agent-card.json>
- Agent skills v0.2.0: <https://x402station.io/.well-known/agent-skills>
- Skill description: <https://x402station.io/skill.md>
- API catalog (RFC 9727): <https://x402station.io/.well-known/api-catalog>
- MCP server card: <https://x402station.io/.well-known/mcp/server-card.json>
- OpenAPI 3.1: <https://x402station.io/api/openapi.json>
- llms.txt: <https://x402station.io/llms.txt>
- Service: <https://x402station.io>
- npm: <https://www.npmjs.com/package/x402station-mcp>
- MCP Registry: <https://registry.modelcontextprotocol.io/v0/servers/io.github.sF1nX/x402station>

## License

MIT — see [LICENSE](./LICENSE).
