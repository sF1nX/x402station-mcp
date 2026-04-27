#!/usr/bin/env node
// x402station-mcp — MCP adapter that exposes the x402station pre-flight oracle
// (preflight / forensics / catalog_decoys) as tools to agents speaking the
// Model Context Protocol (Claude Code, Cursor, Windsurf, Continue, ...).
//
// Transport: stdio (MCP standard). The adapter runs as a child process of the
// agent client. It wraps fetch with @x402/fetch so the first 402 response
// from x402station.io is auto-signed with the agent's wallet and retried.
//
// Config via env:
//   AGENT_PRIVATE_KEY   (required for real calls) 0x-prefixed 64-hex chars.
//                        Must hold USDC on the network x402station is
//                        currently live on (Base Sepolia by default).
//   X402STATION_BASE_URL (optional) default "https://x402station.io".
//                        Useful for testing against a local dev server.
//
// If AGENT_PRIVATE_KEY is missing the adapter still starts — the agent can
// enumerate tools — but any tool call returns a descriptive error so the
// operator knows exactly what to set.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

// Allow-list for the BASE_URL env override. The default canonical host
// covers 99.9% of users. We accept an override only for local dev servers
// because otherwise a malicious config could redirect the agent's signed
// X-PAYMENT request to an attacker-controlled host and harvest telemetry
// or replay payment payloads.
function resolveBaseUrl(raw: string | undefined): string {
  const fallback = "https://x402station.io";
  const value = (raw ?? fallback).replace(/\/+$/, "");

  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`X402STATION_BASE_URL is not a valid URL: ${value}`);
  }

  // Canonical: `u.host` (NOT `u.hostname`) so a non-default port doesn't
  // bypass the allowlist — `https://x402station.io:9999`.hostname is
  // "x402station.io" but `.host` is "x402station.io:9999". Audit
  // 2026-04-26 M-2.
  const canonical = u.host === "x402station.io" && u.protocol === "https:";
  // localDev: `u.hostname` (NOT `u.host` + `startsWith`) so an attacker
  // host like `localhost.attacker.com` or `127.0.0.1.evil.example` can't
  // PASS the loopback check via prefix match. WHATWG `URL.hostname`
  // returns the bracketed form `[::1]` for IPv6 literals (RFC 2732),
  // so exact-match against `[::1]` is correct. CodeRabbit (Mastra PR
  // 2026-04-27).
  const localDev =
    (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") &&
    (u.protocol === "http:" || u.protocol === "https:");

  if (canonical || localDev) return value;

  throw new Error(
    `X402STATION_BASE_URL must be https://x402station.io or a localhost dev URL; got "${value}". ` +
      "Refusing to sign x402 payments against an unknown host — it could replay or harvest payload data.",
  );
}

const BASE_URL = resolveBaseUrl(process.env.X402STATION_BASE_URL);
const PK_RAW = process.env.AGENT_PRIVATE_KEY;

// Validate the private key up-front so tool errors can reference the
// exact problem rather than failing deep inside viem.
function payingFetch() {
  if (!PK_RAW) {
    throw new Error(
      "AGENT_PRIVATE_KEY env var is not set. " +
        "x402station charges $0.001–$0.005 USDC per call via x402; the adapter needs a wallet to sign. " +
        "Set AGENT_PRIVATE_KEY to a 0x-prefixed 64-hex private key for an account that holds Base mainnet USDC (network eip155:8453, USDC contract 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913).",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(PK_RAW)) {
    throw new Error("AGENT_PRIVATE_KEY is malformed — expected 0x + 64 hex chars.");
  }
  const account = privateKeyToAccount(PK_RAW as `0x${string}`);
  // Explicit network list — was `eip155:*` wildcard, which would happily
  // sign payments against Ethereum mainnet (eip155:1) or any other EVM
  // chain if the server ever returned an unexpected 402. Keeping it tight
  // to the two networks x402station actually accepts.
  const scheme = new ExactEvmScheme(account);
  return wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [
      { network: "eip155:8453", client: scheme },   // Base mainnet
      { network: "eip155:84532", client: scheme },  // Base Sepolia
    ],
  });
}

// ---------------------------------------------------------------------------
// Per-call timeout. Without it a stalled oracle (or a hung TCP connection)
// turns into a stuck MCP tool — Claude Code / Cursor / Windsurf / Continue
// all dispatch tool calls synchronously and a multi-minute Node default
// socket timeout bricks the conversation. 30 s covers x402's 402 → sign →
// settle → JSON round-trip with margin. Greptile P2 (2026-04-27).
// ---------------------------------------------------------------------------
const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Call an x402 paid endpoint and return the response body plus the settled
// payment receipt (x-payment-response header) so the agent can log spend.
// ---------------------------------------------------------------------------
async function callPaid(path: string, body: unknown): Promise<string> {
  const f = payingFetch();
  let res: Response;
  try {
    res = await f(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === "AbortError" || e.name === "TimeoutError") {
      throw new Error(
        `x402station ${path} timed out after ${DEFAULT_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  }
  const receipt = res.headers.get("x-payment-response");

  // Read body as text first, then parse JSON ONLY when the response is
  // actually OK. Otherwise nginx 502/504 (Next.js down) would arrive as
  // an HTML body, res.json() would throw a SyntaxError, and the agent
  // would see "Unexpected token '<', '<!DOCTYPE'..." instead of a clear
  // "x402station /api/v1/forensics returned 502" message. Audit M-1.
  const raw = await res.text();
  if (!res.ok) {
    const snippet = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
    throw new Error(`x402station ${path} returned ${res.status}: ${snippet}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `x402station ${path} returned 200 with non-JSON body (first 200 chars): ${raw.slice(0, 200)}`,
    );
  }

  // Decode the receipt header so audit code can read transaction/network/
  // payer rather than a base64 blob. If decode fails (proxy stripped
  // base64, or the header is malformed), surface { raw, malformed: true }
  // so spend-auditing branches can detect the mismatch instead of
  // silently consuming a stub. Greptile P2 (2026-04-27).
  let payment_receipt: unknown = null;
  if (receipt) {
    try {
      payment_receipt = JSON.parse(atob(receipt));
    } catch {
      payment_receipt = { raw: receipt, malformed: true };
    }
  }

  return JSON.stringify({ result: data, payment_receipt }, null, 2);
}

// ---------------------------------------------------------------------------
// Call a free, secret-gated x402station endpoint (watch GET / DELETE). No
// payment wrapping — secret travels in x-x402station-secret header. Same
// non-JSON-on-error guard as callPaid.
// ---------------------------------------------------------------------------
async function callFree(
  path: string,
  method: "GET" | "DELETE",
  secret: string,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { "x-x402station-secret": secret },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === "AbortError" || e.name === "TimeoutError") {
      throw new Error(
        `x402station ${method} ${path} timed out after ${DEFAULT_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  }
  const raw = await res.text();
  if (!res.ok) {
    const snippet = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
    throw new Error(`x402station ${path} returned ${res.status}: ${snippet}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `x402station ${path} returned 200 with non-JSON body (first 200 chars): ${raw.slice(0, 200)}`,
    );
  }
  return JSON.stringify(data, null, 2);
}

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------
const server = new McpServer({
  name: "x402station",
  version: "1.0.6",
});

server.registerTool(
  "preflight",
  {
    title: "Pre-flight safety check",
    description:
      "Ask x402station whether a given x402 URL is safe to pay. Returns {ok, warnings[], metadata}. Costs $0.001 USDC (auto-signed with AGENT_PRIVATE_KEY). Call this BEFORE any other paid x402 request to avoid decoys (price ≥ $1k), zombie services, and dead endpoints. `ok:true` only when no critical warning fires.",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe("The full URL of the x402 endpoint the agent is about to pay."),
    },
  },
  async ({ url }) => {
    try {
      const text = await callPaid("/api/v1/preflight", { url });
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: (err as Error).message }],
      };
    }
  },
);

server.registerTool(
  "forensics",
  {
    title: "7-day forensics report",
    description:
      "Deep history for one x402 endpoint: hourly uptime over 7 days, latency p50/p90/p99, status-code distribution, concentration-group stats (how crowded this provider's namespace is), and a decoy probability score [0, 1]. Costs $0.001 USDC. Superset of preflight — if you're running forensics you don't need preflight too.",
    inputSchema: {
      url: z.string().url().describe("The full URL of the x402 endpoint to analyse."),
    },
  },
  async ({ url }) => {
    try {
      const text = await callPaid("/api/v1/forensics", { url });
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: (err as Error).message }],
      };
    }
  },
);

server.registerTool(
  "catalog_decoys",
  {
    title: "Full decoy / zombie blacklist",
    description:
      "Returns every active x402 endpoint currently flagged decoy_price_extreme / zombie / dead_7d / mostly_dead in one JSON payload, plus per-reason counts. Costs $0.005 USDC. Pull periodically (hourly/daily) and cache locally as a blacklist — cheaper than preflighting every URL.",
    inputSchema: {},
  },
  async () => {
    try {
      const text = await callPaid("/api/v1/catalog/decoys", {});
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: (err as Error).message }],
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Watch tools (M4) — webhook subscription on x402 endpoint state changes.
// ---------------------------------------------------------------------------

const VALID_SIGNALS = [
  "unknown_endpoint",
  "no_history",
  "dead",
  "zombie",
  "decoy_price_extreme",
  "suspicious_high_price",
  "slow",
  "new_provider",
  "dead_7d",
  "mostly_dead",
  "slow_p99",
  "price_outlier_high",
  "high_concentration",
] as const;

server.registerTool(
  "watch_subscribe",
  {
    title: "Subscribe to webhook alerts on x402 endpoint state changes",
    description:
      "Pay $0.01 USDC for a 30-day watch + 100 prepaid alerts on one x402 endpoint. When subscribed signals fire or clear (e.g. endpoint goes zombie, price flips to decoy_price_extreme), x402station POSTs a JSON payload signed with HMAC-SHA256 to your webhookUrl. Returns watchId + secret — STORE THE SECRET, it's the HMAC seed for verifying delivery payloads and is not retrievable later. signals defaults to the critical preflight subset {dead, zombie, decoy_price_extreme}; pass other names to subscribe to non-critical signals too.",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe("The x402 endpoint URL to watch."),
      webhookUrl: z
        .string()
        .url()
        .refine((u) => u.startsWith("https://"), {
          message:
            "webhookUrl must use HTTPS — HMAC-signed alert payloads must not travel in clear text",
        })
        .describe(
          "Where x402station should POST alert payloads. Must be HTTPS (HMAC-signed payloads must travel encrypted) and reachable from the public internet.",
        ),
      signals: z
        .array(z.enum(VALID_SIGNALS))
        .min(1)
        .max(20)
        .optional()
        .describe(
          "Signal names to alert on. Defaults to ['dead', 'zombie', 'decoy_price_extreme']. Full vocabulary covers preflight + forensics signals.",
        ),
    },
  },
  async ({ url, webhookUrl, signals }) => {
    try {
      const body: Record<string, unknown> = { url, webhookUrl };
      if (signals && signals.length > 0) body.signals = signals;
      const text = await callPaid("/api/v1/watch", body);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: (err as Error).message }],
      };
    }
  },
);

server.registerTool(
  "watch_status",
  {
    title: "Check watch subscription status + recent alerts",
    description:
      "Returns the current state of a watch: active/expired, alerts remaining (out of 100 prepaid), last 10 alert deliveries with their delivery_status, and the last computed signal snapshot. Free — no payment required, secret-gated. The secret is the one returned by watch_subscribe.",
    inputSchema: {
      watchId: z
        .string()
        .uuid()
        .describe("The watchId UUID returned by watch_subscribe."),
      secret: z
        .string()
        .length(64)
        .describe("The 64-char hex secret returned by watch_subscribe."),
    },
  },
  async ({ watchId, secret }) => {
    try {
      const text = await callFree(`/api/v1/watch/${watchId}`, "GET", secret);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: (err as Error).message }],
      };
    }
  },
);

server.registerTool(
  "watch_unsubscribe",
  {
    title: "Unsubscribe from a watch (deactivate)",
    description:
      "Deactivates the watch — no further alerts will be queued or delivered. The subscription is set is_active=false but the row + alert history is retained for audit. Free — no payment required, secret-gated. There is no refund for unused prepaid alerts.",
    inputSchema: {
      watchId: z
        .string()
        .uuid()
        .describe("The watchId UUID returned by watch_subscribe."),
      secret: z
        .string()
        .length(64)
        .describe("The 64-char hex secret returned by watch_subscribe."),
    },
  },
  async ({ watchId, secret }) => {
    try {
      const text = await callFree(`/api/v1/watch/${watchId}`, "DELETE", secret);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: (err as Error).message }],
      };
    }
  },
);

// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
