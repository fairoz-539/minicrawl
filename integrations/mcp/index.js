#!/usr/bin/env node
// minicrawl-mcp: a local (stdio) MCP server that forwards to a minicrawl
// server's /mcp endpoint. For apps that only launch local MCP servers, such as
// Claude Desktop. The tool list always matches the server: nothing is duplicated here.
//
//   MINICRAWL_API_URL  your minicrawl server (default http://localhost:3002)
//   MINICRAWL_API_KEY  your minicrawl API key
import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const apiUrl = (process.env.MINICRAWL_API_URL ?? "http://localhost:3002").replace(/\/+$/, "");
const apiKey = process.env.MINICRAWL_API_KEY ?? "";

// stdout carries the MCP protocol, so diagnostics go to stderr.
const log = msg => process.stderr.write(`[minicrawl-mcp] ${msg}\n`);

let upstream = null;

/** Connect to the minicrawl server on first use, and again after a failure. */
async function getUpstream() {
  if (upstream) return upstream;
  const client = new Client({ name: "minicrawl-mcp", version });
  const transport = new StreamableHTTPClientTransport(new URL(`${apiUrl}/mcp`), {
    requestInit: { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
  });
  try {
    await client.connect(transport);
  } catch (err) {
    const hint = /\b401\b|unauthorized/i.test(String(err))
      ? "the API key was rejected: check MINICRAWL_API_KEY"
      : "is the server running and is MINICRAWL_API_URL right?";
    throw new Error(`Cannot connect to minicrawl at ${apiUrl}/mcp (${hint}): ${err.message}`);
  }
  upstream = client;
  return client;
}

/** Forward a request; on failure drop the connection so the next call reconnects. */
async function forward(fn) {
  const client = await getUpstream();
  try {
    return await fn(client);
  } catch (err) {
    upstream = null;
    client.close().catch(() => {});
    throw err;
  }
}

const server = new Server({ name: "minicrawl", version }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, req => forward(c => c.listTools(req.params)));
server.setRequestHandler(CallToolRequestSchema, req => forward(c => c.callTool(req.params)));

await server.connect(new StdioServerTransport());
log(`ready, forwarding to ${apiUrl}/mcp${apiKey ? "" : " (no MINICRAWL_API_KEY set)"}`);
