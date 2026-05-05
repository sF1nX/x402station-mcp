---
title: Safe x402 agent with LangChain
slug: safe-x402-agent-with-langchain
date: 2026-05-05
audience: developers building x402-paying agents on LangChain (TypeScript) or LangGraph
estimated_setup: 5 minutes
---

# Safe x402 agent with LangChain

LangChain agents that pay x402 endpoints typically wire a `Tool` or a `RunnableLambda` around `wrapFetchWithPaymentFromConfig`. The model decides which URL to call, the tool signs payment, and the response flows back into the chain.

The model has no way to tell whether a URL is a [$1,000–$500,000 honeypot](https://x402station.io/blog/x402-honeypot-zone-5x-in-60-days), a zombie service that 100% errors, or an endpoint with zero successful payments ever. This recipe wraps the agent's fetch in `x402station-middleware` (Guard) so a `preflight` check runs before every `PAYMENT-SIGNATURE`. Fail-closed by default. Works the same way in LangGraph nodes.

## What you need

- A LangChain TypeScript project (`langchain`, `@langchain/core`, optionally `@langchain/langgraph`).
- A Base mainnet wallet held by the agent with a small USDC balance (≥ $0.10 covers ~10,000 preflight calls if you buy bulk credits).
- 5 minutes.

## Install

```bash
npm install x402station-middleware @x402/fetch @x402/evm viem
```

## Build a guarded x402 tool

Define one `DynamicStructuredTool` that the model calls whenever it needs to pay an x402 endpoint. Internally, the tool routes through `safeFetch` — the model never touches `fetch` directly, and Guard sits between the model's URL choice and the wallet signature.

```ts
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { wrapWithPreflight } from "x402station-middleware";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);

const x402Fetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    { network: "eip155:8453",  client: new ExactEvmScheme(account) },
    { network: "eip155:84532", client: new ExactEvmScheme(account) },
  ],
});

const safeFetch = wrapWithPreflight(x402Fetch, {
  creditId: process.env.X402STATION_CREDIT_ID, // optional
});

export const x402PayTool = new DynamicStructuredTool({
  name: "pay_x402_endpoint",
  description: "Pay an x402 HTTP endpoint with USDC on Base mainnet and return the response. Will refuse and surface a structured warning if x402station Guard flags the endpoint as decoy / zombie / dead / never_paid.",
  schema: z.object({
    url: z.string().url(),
    body: z.record(z.unknown()).optional(),
  }),
  func: async ({ url, body }) => {
    try {
      const res = await safeFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const text = await res.text();
      try { return JSON.parse(text); } catch { return text; }
    } catch (e: any) {
      if (e?.name === "PreflightBlockedError") {
        // Surface the block as structured tool output so the model sees the
        // warnings and can pick a different URL or fall back to /alternatives.
        return {
          blocked: true,
          warnings: e.warnings,
          recommended_action: e.recommended_action ?? "use_alternatives",
          message: e.message,
        };
      }
      throw e;
    }
  },
});
```

The model now sees `pay_x402_endpoint(url, body)` in its tool list. When it picks a URL, Guard runs preflight, and either the call settles or the model gets a `{ blocked: true, warnings, recommended_action }` response and can decide on a fallback in the next reasoning step.

## Plug into an agent

```ts
import { ChatAnthropic } from "@langchain/anthropic";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { ChatPromptTemplate } from "@langchain/core/prompts";

const llm = new ChatAnthropic({ model: "claude-sonnet-4-6", apiKey: process.env.ANTHROPIC_API_KEY });

const prompt = ChatPromptTemplate.fromMessages([
  ["system", `You are an agent that uses x402-paid HTTP endpoints to fulfil tasks.
When you call \`pay_x402_endpoint\`, the response may include \`blocked: true\` if x402station Guard flagged the URL.
On a block, do not retry the same URL — read \`recommended_action\` and \`warnings\`, then pick a different endpoint or call \`/alternatives\` if available.`],
  ["human", "{input}"],
  ["placeholder", "{agent_scratchpad}"],
]);

const agent = await createToolCallingAgent({ llm, tools: [x402PayTool], prompt });
const executor = new AgentExecutor({ agent, tools: [x402PayTool], verbose: true });

const result = await executor.invoke({ input: "Get a price quote from https://api.example.com/x402-endpoint for USD/EUR." });
```

If the URL is a decoy, the tool returns `{ blocked: true, warnings: ["decoy_price_extreme"], recommended_action: "use_alternatives" }`. The agent reads it and avoids the wallet drain.

## LangGraph version

In a LangGraph state machine, put the guarded fetch in a node:

```ts
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

const tools = [x402PayTool];
const toolNode = new ToolNode(tools);

const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addEdge("__start__", "agent")
  .addConditionalEdges("agent", (state) => {
    const last = state.messages[state.messages.length - 1];
    return last.tool_calls?.length ? "tools" : "__end__";
  })
  .addEdge("tools", "agent")
  .compile();
```

Same Guard semantics — the `pay_x402_endpoint` tool is the single chokepoint where preflight runs.

## Bulk credits

If your LangChain agent makes many paid calls per session:

```ts
const creditRes = await safeFetch("https://x402station.io/api/v1/credits", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
});
const { creditId } = await creditRes.json(); // $0.50 → 1000 prepaid preflights
// Store the creditId in agent memory or a KV. Pass it on every wrapWithPreflight init:
const safeFetch = wrapWithPreflight(x402Fetch, { creditId });
```

## MCP alternative — let the model call x402station tools directly

If you want the model to also have explicit access to forensics, alternatives, and the decoy catalog (rather than just preflight-on-pay), connect the [`x402station-mcp`](https://www.npmjs.com/package/x402station-mcp) server. LangChain's MCP adapter exposes those 10 tools as standard `Tool` instances:

```bash
npm install @langchain/mcp-adapters
```

```ts
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

const client = new MultiServerMCPClient({
  mcpServers: {
    x402station: {
      command: "npx",
      args: ["-y", "x402station-mcp"],
      env: { AGENT_PRIVATE_KEY: process.env.AGENT_PRIVATE_KEY! },
    },
  },
});

const x402stationTools = await client.getTools(); // preflight, forensics, catalog_decoys, alternatives, ...
const tools = [x402PayTool, ...x402stationTools];
```

Now the agent has both: `pay_x402_endpoint` (Guard wraps the wallet) and explicit `preflight` / `forensics` / `alternatives` tools (MCP).

## Test against a known decoy

```ts
const result = await x402PayTool.invoke({
  url: "https://api.example-decoy.com/x402/swarm-endpoint", // pull one from /api/v1/catalog/decoys
});
// result = { blocked: true, warnings: ["decoy_price_extreme"], recommended_action: "use_alternatives", message: "..." }
```

## Rollout checklist

- [ ] `npm install x402station-middleware @x402/fetch @x402/evm viem`
- [ ] `AGENT_PRIVATE_KEY` set with a Base mainnet wallet that holds USDC (≥ $0.10)
- [ ] `pay_x402_endpoint` tool defined; `safeFetch` is the only path the agent has to x402 URLs
- [ ] System prompt teaches the model to read `blocked: true` + `recommended_action` and not retry blocked URLs
- [ ] (Optional) Bulk credits purchased; `X402STATION_CREDIT_ID` in env or KV
- [ ] (Optional) `@langchain/mcp-adapters` wires the full 10-tool x402station MCP server for explicit preflight / forensics / alternatives reasoning
- [ ] Test against a known-decoy URL → confirmed `{ blocked: true }` → confirmed agent picks an alternative

## Source links

- npm: [`x402station-middleware`](https://www.npmjs.com/package/x402station-middleware)
- npm: [`x402station-mcp`](https://www.npmjs.com/package/x402station-mcp) (10 tools, stdio MCP)
- API docs: [https://x402station.io/api](https://x402station.io/api)
- OpenAPI: [https://x402station.io/api/openapi.json](https://x402station.io/api/openapi.json)
- LangChain MCP adapter: [@langchain/mcp-adapters](https://github.com/langchain-ai/langchainjs/tree/main/libs/langchain-mcp-adapters)
- Reach the team: [hello@x402station.io](mailto:hello@x402station.io)
