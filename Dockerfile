# x402station-mcp — stdio MCP server.
#
# Image is intentionally minimal: install the published npm package and
# expose its `bin` as the entrypoint. Glama's listing check only needs the
# server to start and respond to `initialize` / `tools/list` over stdio,
# which works without `AGENT_PRIVATE_KEY` (the adapter starts and enumerates
# tools without it; only paid tool *calls* require the key).
#
# Pinned to a specific patch release so a runaway publish can't change
# image behaviour. Bump alongside `version` in package.json + server.json.

FROM node:20-alpine

LABEL org.opencontainers.image.title="x402station-mcp"
LABEL org.opencontainers.image.description="MCP adapter for x402station — pre-flight oracle for x402 endpoints"
LABEL org.opencontainers.image.url="https://x402station.io"
LABEL org.opencontainers.image.source="https://github.com/sF1nX/x402station-mcp"
LABEL org.opencontainers.image.licenses="MIT"

RUN npm install -g x402station-mcp@1.0.10

ENTRYPOINT ["x402station-mcp"]
