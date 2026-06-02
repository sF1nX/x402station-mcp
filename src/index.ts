#!/usr/bin/env node
// x402station-mcp — MCP adapter that exposes Preflight by x402station.io
// (preflight / forensics / catalog_decoys) as tools to agents speaking the
// Model Context Protocol (Claude Code, Cursor, Windsurf, Continue, ...).
//
// Transport: stdio (MCP standard). The adapter runs as a child process of the
// agent client. It wraps fetch with @x402/fetch so the first 402 response
// from x402station.io is auto-signed with the agent's wallet and retried.
//
// Config via env:
//   AGENT_PRIVATE_KEY   (required for real calls) 0x-prefixed 64-hex chars.
//                        Must hold Base mainnet USDC for paid tool calls.
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
// PAYMENT-SIGNATURE request to an attacker-controlled host and harvest telemetry
// or replay payment payloads.
function resolveBaseUrl(raw: string | undefined): string {
  const fallback = "https://x402station.io";
  // .trim() before slash-strip — env values pasted from a `.env` file
  // sometimes carry leading/trailing whitespace which would otherwise make
  // `new URL(" https://...")` throw, leaving the operator with a confusing
  // URL-parse error instead of a clean canonical-host check. Audit
  // 2026-04-28 (Sonnet MEDIUM on mcp-adapter).
  const value = (raw ?? fallback).trim().replace(/\/+$/, "");

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

// Pure (no DNS) host check for `webhookUrl` on watch_subscribe. Fails fast
// LOCAL when the operator passes a private/loopback/cloud-metadata host,
// before the call reaches our server (which has its own SSRF guard at
// /api/v1/watch — but a 400 round-trip would burn UX in copy-paste dev
// flows). Mirrors the server-side ranges from src/ssrf-guard.ts; client-
// side defense-in-depth. Audit-2026-04-29 recon-7 HIGH-8.
//
// IPv4 ranges blocked: this-network 0/8, RFC1918 (10/8, 172.16/12,
// 192.168/16), loopback 127/8, link-local + cloud metadata 169.254/16,
// IETF reserved 192.0.0/24, CGNAT/Tailscale 100.64/10, multicast 224/4.
//
// IPv6: loopback ::1, unspec ::, link-local fe80::/10, ULA fc00::/7,
// multicast ff00::/8, v4-mapped/v4-compat (low 32 bits could be private),
// NAT64 64:ff9b::/96 + local-use 64:ff9b:1::/48, RFC 6666 discard 100::/64,
// 6to4 2002::/16, Teredo 2001::/32, doc 2001:db8::/32 + 3fff::/20,
// benchmarking 2001:2::/48, SRv6 5f00::/16. Pattern-match on the lowercased
// hostname for prefix-based ranges; not a full bit-CIDR (good-enough for
// client-side early rejection — server has the canonical guard).
function isPrivateIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const a = Number.parseInt(m[1]!, 10);
  const b = Number.parseInt(m[2]!, 10);
  const c = Number.parseInt(m[3]!, 10);
  const d = Number.parseInt(m[4]!, 10);
  if ([a, b, c, d].some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → block
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(host: string): boolean {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "::" || h === "::1") return true;
  if (/^fe[89ab]/.test(h)) return true;
  if (/^f[cd]/.test(h)) return true;
  if (/^ff/.test(h)) return true;
  if (h.startsWith("::ffff:")) return true;
  if (h.startsWith("::") && h.length > 2 && /^::[0-9a-f]/.test(h)) return true;
  if (h.startsWith("64:ff9b:")) return true;
  if (h.startsWith("100:")) return true;
  if (h.startsWith("2001:db8")) return true;
  if (/^3fff/.test(h)) return true;
  if (h.startsWith("2001:2:") || h.startsWith("2001:0002:")) return true;
  if (h.startsWith("5f00:")) return true;
  if (h.startsWith("2002:")) return true;
  if (h.startsWith("2001::") || /^2001:0+:/.test(h)) return true;
  return false;
}

const LOCALHOST_NAMES = new Set(["localhost", "localhost.localdomain"]);

/**
 * Returns the rejection reason as a string when `rawUrl` should be refused,
 * or `null` when the URL is acceptable for use as a webhookUrl. Plain
 * `string | null` (not a discriminated union) so dts emits in downstream
 * SDK packages don't trip on TS narrowing inside zod superRefine blocks.
 */
export function validateWebhookUrl(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return "invalid URL";
  }
  if (u.protocol !== "https:") {
    return "webhookUrl must use HTTPS — HMAC-signed alert payloads must not travel in clear text";
  }
  if (u.username !== "" || u.password !== "") {
    return "webhookUrl must not contain userinfo (user:pass@host) — known phishing/spoofing vector";
  }
  const hostname = u.hostname.toLowerCase();
  if (LOCALHOST_NAMES.has(hostname)) {
    return `webhookUrl hostname is loopback (${hostname})`;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    if (isPrivateIPv4(hostname)) {
      return `webhookUrl IPv4 ${hostname} is loopback / private / link-local / cloud-metadata`;
    }
  }
  if (hostname.startsWith("[")) {
    if (isPrivateIPv6(hostname)) {
      return `webhookUrl IPv6 ${hostname} is loopback / ULA / link-local / v4-mapped / NAT64`;
    }
  }
  return null;
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
// Per-call timeout. Without it a stalled risk-signal call (or a hung TCP connection)
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
    // If the receipt header is set, settlement happened upstream — surface
    // that so the agent doesn't retry quickly and double-charge. The body
    // (if JSON-parseable) likely already carries `payment_settled: true`
    // for routes that adopted the audit-2026-04-28 pattern; we mention
    // the receipt presence on the error message itself for the older 503
    // shapes too. Audit 2026-04-28 (Sonnet HIGH-2 on mcp-adapter).
    const settled = receipt ? " (PAYMENT SETTLED — do NOT retry quickly)" : "";
    throw new Error(`x402station ${path} returned ${res.status}${settled}: ${snippet}`);
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
  //
  // 4 KB size cap before atob (audit 2026-04-28 / Sonnet HIGH on
  // mcp-adapter). Real receipts are <512 bytes; 4 KB is generous. Without
  // the cap, a malicious / misconfigured proxy attaching a multi-megabyte
  // blob would force an OOM in this single-threaded MCP process and drop
  // the stdio transport silently.
  const RECEIPT_MAX_LEN = 4096;
  let payment_receipt: unknown = null;
  if (receipt) {
    if (receipt.length > RECEIPT_MAX_LEN) {
      payment_receipt = { raw: receipt.slice(0, 64) + "…", malformed: true, oversize: true };
    } else {
      try {
        payment_receipt = JSON.parse(atob(receipt));
      } catch {
        payment_receipt = { raw: receipt, malformed: true };
      }
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
  // The watch routes need x-x402station-secret. The credits-status route
  // (id-gated, secret-less) doesn't — pass an empty string and we skip the
  // header so we don't ship "x-x402station-secret: " (could trip a
  // future strict-validation check).
  const headers: Record<string, string> = {};
  if (secret) headers["x-x402station-secret"] = secret;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
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
  name: "x402station.io",
  version: "1.0.11",
});

server.registerTool(
  "preflight",
  {
    title: "Preflight risk check",
    description:
      "Preflight x402 scam check: endpoint risk before you pay — decoy / zombie / price-trap / never-paid? Trust verdict in ~200ms before PAYMENT-SIGNATURE.",
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
      "Forensic x402 scam/risk report for a suspicious endpoint: probe history, signatures, decoy / price-trap patterns.",
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
      "Searchable catalog of x402 endpoint risk signals; scam-like decoys, zombies, and price-traps flagged.",
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

server.registerTool(
  "buy_credits",
  {
    title: "Buy prepaid preflight credits",
    description:
      "Prepaid credit pack for high-frequency x402 scam checks, preflight, and verified calls. Returns { creditId, balance, expiresAt }; use X-Credit-Id on subsequent preflight calls.",
    inputSchema: {},
  },
  async () => {
    try {
      const text = await callPaid("/api/v1/credits", {});
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
  "credits_status",
  {
    title: "Read a credit's current balance + expiry",
    description:
      "Free, no payment required. Returns { creditId, balance, initialBalance, used, paidAmount, createdAt, expiresAt, expired, paymentTx, paymentNetwork }. UUID-only access — anyone holding the creditId can read state, same as decrement. 404 covers both 'malformed UUID' and 'no such credit' (same body so an attacker scraping random UUIDs can't tell them apart).",
    inputSchema: {
      creditId: z
        .string()
        .uuid()
        .describe("The creditId UUID returned by buy_credits."),
    },
  },
  async ({ creditId }) => {
    try {
      const text = await callFree(`/api/v1/credits/${creditId}`, "GET", "");
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
  "whats_new",
  {
    title: "Catalog diff polling — added / removed endpoints since `since`",
    description:
      "Polling-friendly catalog diff. Body { since?, limit? } (default since=now-24h, limit=200, max 500). Returns added_endpoints[] (first_seen_at >= since AND is_active=true), removed_endpoints[] (flipped to is_active=false since), service-level counts, polls_in_window, and current active totals. Cheap ($0.001 USDC) so hourly polling stays under $1/month — perfect for aggregator agents that need a fresh delta without re-pulling the whole catalog. Internal ingest cron runs every 5 min, so polling more often than that returns identical data.",
    inputSchema: {
      since: z
        .string()
        .datetime()
        .refine(
          (s) => new Date(s).getTime() <= Date.now() + 60_000,
          { message: "`since` cannot be in the future (server allows 60s clock-skew slack)" },
        )
        .optional()
        .describe(
          "ISO 8601 timestamp. Default = now() - 24h. Cannot be older than 30 days or in the future.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Per-list cap (1..500, default 200). Applied independently to added_endpoints and removed_endpoints."),
    },
  },
  async ({ since, limit }) => {
    try {
      const body: Record<string, unknown> = {};
      if (since) body.since = since;
      if (limit !== undefined) body.limit = limit;
      const text = await callPaid("/api/v1/whats-new", body);
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
  "alternatives",
  {
    title: "Routing fallback — siblings to a flagged endpoint",
    description:
      "Avoid paying unsafe x402 endpoints: ranked safe alternatives for the same capability.",
    inputSchema: {
      url: z
        .string()
        .url()
        .optional()
        .describe(
          "URL flagged by preflight (or otherwise rejected). Looked up in the catalog to extract provider / domain / category / price band as match keys.",
        ),
      taskClass: z
        .string()
        .min(1)
        .max(80)
        .regex(/\S/, "taskClass must contain at least one non-whitespace char")
        .optional()
        .describe(
          "Service category hint (e.g. 'llm-completions', 'Inference'). Used as a fallback match key when `url` is unknown to the catalog, OR alone for category-only discovery.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Max alternatives to return (1..10, default 5)."),
    },
  },
  async ({ url, taskClass, limit }) => {
    if (!url && !taskClass) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: "alternatives requires at least one of `url` or `taskClass`.",
          },
        ],
      };
    }
    try {
      const body: Record<string, unknown> = {};
      if (url) body.url = url;
      if (taskClass) body.taskClass = taskClass;
      if (limit !== undefined) body.limit = limit;
      const text = await callPaid("/api/v1/alternatives", body);
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
      "Monitor x402 endpoint risk; webhook on scam-like decoy / zombie / price-trap status changes. Returns watchId + secret; x402station.io posts HMAC-SHA256-signed JSON when subscribed signals fire or clear.",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe("The x402 endpoint URL to watch."),
      webhookUrl: z
        .string()
        .url()
        .superRefine((u, ctx) => {
          const reason = validateWebhookUrl(u);
          if (reason !== null) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: reason });
          }
        })
        .describe(
          "Where x402station should POST alert payloads. Must be HTTPS, reachable from the public internet, and contain no userinfo (no user:pass@host). Loopback (127.0.0.1, ::1, localhost), private (RFC1918, link-local 169.254/16 incl. cloud metadata, CGNAT/Tailscale 100.64/10) and IPv6 ULA / multicast / NAT64 / 6to4 / Teredo hosts are rejected client-side; the server applies the same SSRF guard if you bypass this check.",
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
