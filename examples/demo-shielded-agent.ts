// x402-shielded-agent demo — a standalone third-party agent that uses
// x402station as its safety oracle before paying any x402 endpoint.
//
// Exercises ALL six endpoints from a CLIENT perspective (not from
// inside the codebase that hosts them):
//
//   1. catalog_decoys       paid $0.005   pull blacklist, cache locally
//   2. preflight (safe)     paid $0.001   ok=true expected
//   3. preflight (decoy)    paid $0.001   ok=false expected
//   4. forensics            paid $0.001   7-day report on safe URL
//   5. watch_subscribe      paid $0.01    30-day watch, 100 alerts
//   6. watch_status         free          read-back the watch
//   7. watch_unsubscribe    free          cleanup
//
// Total cost: $0.018 USDC. Settles from the test-sender wallet
// (PROBER_PRIVATE_KEY = 0x30d2b1f9…, ~$0.09 USDC remaining; this run
// uses ~20% of that, so good for ~5 more cycles before refund).
//
// Output: pretty-printed transcript on stdout AND a structured JSON
// report at data/demo-runs/<timestamp>.json — useful as a demo
// artefact for the article and as ground truth for any future
// regression test.
//
// Run:  bun run scripts/demo-shielded-agent.ts [--prod]
//   --prod   hit https://x402station.io (default: localhost:3002)

import {
  wrapFetchWithPaymentFromConfig,
  decodePaymentResponseHeader,
} from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const useProd = args.includes("--prod");
const API_BASE = useProd ? "https://x402station.io" : "http://localhost:3002";

// Two real-world targets pulled from the agentic.market catalog so the
// demo exercises live data (not synthetic URLs that would always return
// unknown_endpoint).
const SAFE_TARGET = "https://api.venice.ai/api/v1/chat/completions";
// Decoy: a Questflow-class endpoint priced ≥ $1k USDC. We don't pay this
// — preflight should refuse before any payment to it leaves a wallet.
const DECOY_TARGET =
  "https://questflow.ai/api/v1/agent/swarm/cs-research-swarm";

// ---------- Wallet wiring ----------
const pk = process.env.PROBER_PRIVATE_KEY;
if (!pk || !pk.startsWith("0x") || pk.length !== 66) {
  console.error("✗ PROBER_PRIVATE_KEY missing or malformed in .env");
  process.exit(1);
}
const account = privateKeyToAccount(pk as `0x${string}`);
const scheme = new ExactEvmScheme(account);
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    { network: "eip155:8453", client: scheme },
    { network: "eip155:84532", client: scheme },
  ],
});

// ---------- Pretty output helpers ----------
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
};

function step(n: number, title: string, price: string) {
  console.log(
    `\n${c.bold}${c.cyan}[${n}/7] ${title}${c.reset} ${c.dim}(${price})${c.reset}`,
  );
}

function ok(msg: string) {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}

function fail(msg: string) {
  console.log(`  ${c.red}✗${c.reset} ${msg}`);
}

function info(msg: string) {
  console.log(`  ${c.dim}${msg}${c.reset}`);
}

// ---------- Each step ----------

type StepResult = {
  step: string;
  ok: boolean;
  costUsdc?: string;
  txHash?: string;
  durationMs: number;
  body?: unknown;
  error?: string;
};

const transcript: StepResult[] = [];

async function callPaid(
  path: string,
  body: unknown,
  expectedPriceUsdc: string,
): Promise<StepResult> {
  const t0 = Date.now();
  try {
    const r = await fetchWithPayment(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const durationMs = Date.now() - t0;
    const xpay = r.headers.get("x-payment-response");
    let txHash: string | undefined;
    if (xpay) {
      try {
        const dec = decodePaymentResponseHeader(xpay) as { transaction?: string };
        txHash = dec?.transaction;
      } catch {
        // x-payment-response present but unparseable — no big deal,
        // settlement still happened (status 200 confirms it).
      }
    }
    if (!r.ok) {
      const text = await r.text();
      return {
        step: path,
        ok: false,
        durationMs,
        error: `HTTP ${r.status}: ${text.slice(0, 200)}`,
      };
    }
    const json = await r.json();
    return {
      step: path,
      ok: true,
      costUsdc: expectedPriceUsdc,
      txHash,
      durationMs,
      body: json,
    };
  } catch (e) {
    return {
      step: path,
      ok: false,
      durationMs: Date.now() - t0,
      error: (e as Error).message?.slice(0, 200),
    };
  }
}

async function callFree(
  path: string,
  method: "GET" | "DELETE",
  secret: string,
): Promise<StepResult> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { "x-x402station-secret": secret },
    });
    const durationMs = Date.now() - t0;
    if (!r.ok) {
      const text = await r.text();
      return {
        step: `${method} ${path}`,
        ok: false,
        durationMs,
        error: `HTTP ${r.status}: ${text.slice(0, 200)}`,
      };
    }
    const json = await r.json();
    return {
      step: `${method} ${path}`,
      ok: true,
      costUsdc: "0",
      durationMs,
      body: json,
    };
  } catch (e) {
    return {
      step: `${method} ${path}`,
      ok: false,
      durationMs: Date.now() - t0,
      error: (e as Error).message?.slice(0, 200),
    };
  }
}

// ---------- Main flow ----------

console.log(`${c.bold}${c.blue}━━━ x402-shielded-agent demo ━━━${c.reset}`);
console.log(`  paying from: ${c.cyan}${account.address}${c.reset}`);
console.log(`  oracle base: ${c.cyan}${API_BASE}${c.reset}`);
console.log(`  safe target: ${c.cyan}${SAFE_TARGET}${c.reset}`);
console.log(`  decoy target: ${c.yellow}${DECOY_TARGET}${c.reset}`);

// Step 1: pull blacklist
step(1, "catalog_decoys → cache local blacklist", "$0.005");
const r1 = await callPaid("/api/v1/catalog/decoys", {}, "0.005");
transcript.push(r1);
type DecoysBody = {
  counts?: { total?: number; by_reason?: Record<string, number> };
  truncated?: boolean;
  entries?: Array<{ url: string; reasons: string[] }>;
};
let decoyBlacklist = new Set<string>();
if (r1.ok) {
  const body = r1.body as DecoysBody;
  ok(
    `${body.counts?.total ?? 0} decoy entries (${
      Object.entries(body.counts?.by_reason ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "—"
    })${body.truncated ? ", truncated" : ""}`,
  );
  decoyBlacklist = new Set((body.entries ?? []).map((e) => e.url));
  info(`local blacklist size: ${decoyBlacklist.size} URLs`);
} else {
  fail(r1.error ?? "unknown error");
}

// Step 2: preflight on safe
step(2, "preflight on safe URL", "$0.001");
const r2 = await callPaid("/api/v1/preflight", { url: SAFE_TARGET }, "0.001");
transcript.push(r2);
type PreflightBody = {
  ok?: boolean;
  warnings?: string[];
  metadata?: Record<string, unknown>;
};
if (r2.ok) {
  const body = r2.body as PreflightBody;
  const decision = body.ok
    ? `${c.green}PROCEED${c.reset}`
    : `${c.red}REFUSE${c.reset}`;
  ok(`preflight returned ok=${body.ok} → ${decision}`);
  info(`warnings: [${(body.warnings ?? []).join(", ") || "none"}]`);
  info(`uptime_1h_pct=${(body.metadata as { uptime_1h_pct?: number } | undefined)?.uptime_1h_pct ?? "n/a"}`);
} else {
  fail(r2.error ?? "unknown error");
}

// Step 3: preflight on decoy
step(3, "preflight on decoy URL (must refuse)", "$0.001");
const r3 = await callPaid("/api/v1/preflight", { url: DECOY_TARGET }, "0.001");
transcript.push(r3);
if (r3.ok) {
  const body = r3.body as PreflightBody;
  const refused = body.ok === false;
  if (refused) {
    ok(
      `correctly refused: ok=${body.ok}, warnings=[${
        (body.warnings ?? []).join(", ") || "none"
      }]`,
    );
  } else {
    fail(`UNEXPECTED: oracle did NOT refuse a known decoy! body=${JSON.stringify(body).slice(0, 200)}`);
  }
} else {
  fail(r3.error ?? "unknown error");
}

// Step 4: forensics
step(4, "forensics on safe URL (deep history)", "$0.001");
const r4 = await callPaid("/api/v1/forensics", { url: SAFE_TARGET }, "0.001");
transcript.push(r4);
// decoy_probability is top-level; uptime + latency are nested objects
// (NOT inside metadata, which is just identity fields). First demo run
// had this wrong — fixed after inspecting the actual transcript JSON.
type ForensicsBody = {
  ok?: boolean;
  warnings?: string[];
  decoy_probability?: number;
  uptime?: {
    uptime_7d_pct?: number;
    uptime_1h_pct?: number;
    probes_7d?: number;
    healthy_7d?: number;
    avg_latency_1h_ms?: number;
  };
  latency?: { p50_ms?: number; p90_ms?: number; p99_ms?: number };
};
if (r4.ok) {
  const body = r4.body as ForensicsBody;
  ok(
    `forensics returned: ok=${body.ok}, warnings=[${
      (body.warnings ?? []).join(", ") || "none"
    }]`,
  );
  info(
    `uptime_7d_pct=${body.uptime?.uptime_7d_pct ?? "n/a"}% (${body.uptime?.healthy_7d ?? "?"}/${body.uptime?.probes_7d ?? "?"} probes), uptime_1h_pct=${body.uptime?.uptime_1h_pct ?? "n/a"}%`,
  );
  info(
    `latency p50/p90/p99 ms = ${body.latency?.p50_ms ?? "n/a"} / ${body.latency?.p90_ms ?? "n/a"} / ${body.latency?.p99_ms ?? "n/a"}`,
  );
  info(`decoy_probability=${body.decoy_probability ?? "n/a"}`);
} else {
  fail(r4.error ?? "unknown error");
}

// Step 5: watch_subscribe
step(5, "watch_subscribe on safe URL", "$0.01");
const r5 = await callPaid(
  "/api/v1/watch",
  {
    url: SAFE_TARGET,
    webhookUrl: "https://example.com/x402-shielded-agent-demo",
    signals: ["zombie", "decoy_price_extreme", "dead"],
  },
  "0.01",
);
transcript.push(r5);
type WatchBody = {
  watchId?: string;
  secret?: string;
  expiresAt?: string;
  alertsPaid?: number;
};
let watchId: string | undefined;
let watchSecret: string | undefined;
if (r5.ok) {
  const body = r5.body as WatchBody;
  watchId = body.watchId;
  watchSecret = body.secret;
  ok(`subscribed: watchId=${watchId}`);
  info(`expires=${body.expiresAt}, alerts_paid=${body.alertsPaid}`);
} else {
  fail(r5.error ?? "unknown error");
}

// Step 6: watch_status
if (watchId && watchSecret) {
  step(6, "watch_status (free, secret-gated)", "free");
  const r6 = await callFree(
    `/api/v1/watch/${watchId}`,
    "GET",
    watchSecret,
  );
  transcript.push(r6);
  type StatusBody = {
    isActive?: boolean;
    alertsRemaining?: number;
    expired?: boolean;
  };
  if (r6.ok) {
    const body = r6.body as StatusBody;
    ok(`status: isActive=${body.isActive}, alertsRemaining=${body.alertsRemaining}, expired=${body.expired}`);
  } else {
    fail(r6.error ?? "unknown error");
  }

  // Step 7: watch_unsubscribe
  step(7, "watch_unsubscribe (free, cleanup)", "free");
  const r7 = await callFree(
    `/api/v1/watch/${watchId}`,
    "DELETE",
    watchSecret,
  );
  transcript.push(r7);
  if (r7.ok) {
    ok(`unsubscribed cleanly`);
  } else {
    fail(r7.error ?? "unknown error");
  }
} else {
  console.log(
    `\n${c.yellow}⊘ skipping steps 6-7: watch_subscribe failed, no watchId/secret${c.reset}`,
  );
}

// ---------- Summary ----------
const total = transcript.reduce(
  (s, r) => s + (r.costUsdc ? Number(r.costUsdc) : 0),
  0,
);
const passed = transcript.filter((r) => r.ok).length;
const failed = transcript.length - passed;
console.log(
  `\n${c.bold}━━━ summary ━━━${c.reset}`,
);
console.log(`  steps run:   ${transcript.length}`);
console.log(`  ok:          ${c.green}${passed}${c.reset}`);
console.log(`  failed:      ${failed > 0 ? c.red : c.dim}${failed}${c.reset}`);
console.log(`  total spend: ${c.yellow}$${total.toFixed(3)} USDC${c.reset}`);
console.log(`  oracle base: ${API_BASE}`);

// Persist transcript for the article / regression baseline.
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join("data", "demo-runs");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${ts}.json`);
writeFileSync(
  outFile,
  JSON.stringify(
    {
      runAt: new Date().toISOString(),
      apiBase: API_BASE,
      payer: account.address,
      safeTarget: SAFE_TARGET,
      decoyTarget: DECOY_TARGET,
      totalSpendUsdc: total,
      passed,
      failed,
      transcript,
    },
    null,
    2,
  ),
);
console.log(`  transcript:  ${outFile}\n`);

process.exit(failed > 0 ? 1 : 0);
