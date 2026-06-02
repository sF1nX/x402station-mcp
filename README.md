[![Glama MCP server score](https://glama.ai/mcp/servers/sF1nX/x402station-mcp/badges/score.svg)](https://glama.ai/mcp/servers/@sF1nX/x402station-mcp)

# x402station-mcp

<!-- mcp-name: io.github.sF1nX/x402station -->

MCP adapter for **[x402station.io](https://x402station.io)**, the **independent risk-signal layer for x402 agentic commerce**. Exposes Preflight by x402station.io plus Forensics, Catalog Decoys, Alternatives, Credits, Watch, and Whats New. Any agent speaking the Model Context Protocol gets endpoint evidence before signing `PAYMENT-SIGNATURE` — **decoy, zombie, price-trap, never-paid, latency, signature/settlement checks** — before paying.

x402station.io independently probes every endpoint listed on agentic.market every 10 minutes and merges probe history with CDP settlement data. Policy engines decide and enforce; x402station.io measures and reports. We do not route, take custody, or endorse.

## Install

```bash
# Claude Code / Cursor / Windsurf / Continue — works anywhere with MCP
npm install -g x402station-mcp
# or use npx in the config, no global install needed:
```

## Configure

The adapter charges real USDC per paid call through x402 itself. You need a wallet private key that holds Base mainnet USDC.

### Claude Code

Add to `~/.claude/claude_desktop_config.json` (or wherever your MCP servers live):

```json
{
  "mcpServers": {
    "x402station": {
      "command": "npx",
      "args": ["-y", "x402station-mcp"],
      "env": {
        "AGENT_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY_HERE"
      }
    }
  }
}
```

### Cursor / Windsurf / Continue

Same shape — every MCP host understands `command` / `args` / `env`. See your tool's MCP docs.

### Environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AGENT_PRIVATE_KEY` | **yes** for any paid tool call | — | 0x-prefixed 64-hex-char private key. Account must hold Base mainnet USDC. |
| `X402STATION_BASE_URL` | no | `https://x402station.io` | Override for dev / testing. |

## Tools

### `preflight(url)` — $0.001 USDC

Ask whether it's safe to pay this x402 URL. Returns:

```json
{
  "ok": true,
  "warnings": [],
  "metadata": {
    "service": "...",
    "price_usdc": "0.01",
    "uptime_1h_pct": 100,
    "avg_latency_ms": 412
  }
}
```

`ok` is `true` only when no critical warning fires. Warnings include `unknown_endpoint`, `no_history`, `dead`, `zombie`, `decoy_price_extreme`, `never_paid_zombie`, `proxy_markup`, `wildcard_402`, `spa_fallback`, `suspicious_high_price`, `slow`, and `new_provider`.

### `forensics(url)` — $0.001 USDC

Deep 7-day report. Superset of preflight. Returns hourly uptime, latency p50/p90/p99, status-code distribution, concentration-group stats, decoy probability. Extra warnings: `dead_7d`, `mostly_dead`, `slow_p99`, `price_outlier_high`, `high_concentration`.

### `catalog_decoys()` — $0.005 USDC

Full blacklist. Returns every active endpoint currently flagged critical, plus per-reason counts. Pull periodically and cache locally — cheaper than preflighting every URL.

## Typical agent flow

```
agent wants data from some_endpoint.com
    │
    ├─ preflight("https://some_endpoint.com/data")  ← $0.001
    │     ok: false, warnings: ["decoy_price_extreme"]
    │
    └─ skip; try the next candidate
```

For bulk discovery, do `catalog_decoys()` once per day and treat the result as a set-difference against any URLs you're about to hit.

## Composes with

x402station checks whether the **endpoint** is safe (decoy / zombie / price-trap / never-paid) before an agent pays. It pairs naturally with a **payload** safety check — screening the payment metadata for PII before signing:

```
agent intent: pay some_endpoint.com
    ├─ x402station    preflight(url)              ← is the ENDPOINT safe?
    ├─ presidio-x402  screen_payment_metadata()   ← is the PAYLOAD safe?
    └─ pay()
```

[`presidio-hardened-x402-mcp`](https://github.com/presidio-v/presidio-hardened-x402-mcp) screens payment metadata for PII before signing. The two servers are developed independently, on purpose — keeping the signals uncorrelated is the point. This is a composition pointer, not an endorsement; see their repo for the screening tool's behaviour and limits.

## Links

- Service: https://x402station.io
- Manifest: https://x402station.io/.well-known/x402
- OpenAPI: https://x402station.io/api/openapi.json
- Dataset: https://huggingface.co/datasets/x402station/preflight-dataset-v0_1
- GitHub: https://github.com/sF1nX/x402station-mcp
- x402 spec: https://x402.org

## Contact

- General + commercial: <hello@x402station.io>
- Bug reports: <https://github.com/sF1nX/x402station-mcp/issues>
- Security disclosures (RFC 9116): <https://x402station.io/.well-known/security.txt>

## License

MIT
