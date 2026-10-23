# minicrawl-mcp

A local [MCP](https://modelcontextprotocol.io) server that gives AI apps like **Claude Desktop** your self-hosted **[minicrawl](https://github.com/fairoz-539/minicrawl)**: web scraping, crawling, site maps, web search and AI extraction.

It forwards to your minicrawl server's built-in `/mcp` endpoint. Apps that support remote MCP servers (Claude Code, Cursor, VS Code) can connect to that endpoint directly without this package; see the [integrations guide](https://github.com/fairoz-539/minicrawl/blob/main/docs/INTEGRATIONS.md).

## Setup

1. Run minicrawl ([quick start](https://github.com/fairoz-539/minicrawl#-quick-start)) and note your API key from `.env`.
2. Add this to your app's MCP configuration. For Claude Desktop that's **Settings → Developer → Edit Config** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "minicrawl": {
      "command": "npx",
      "args": ["-y", "minicrawl-mcp"],
      "env": {
        "MINICRAWL_API_URL": "http://localhost:3002",
        "MINICRAWL_API_KEY": "your-minicrawl-api-key"
      }
    }
  }
}
```

3. Restart the app. The minicrawl tools appear in its tools list.

| Variable | Default | |
|---|---|---|
| `MINICRAWL_API_URL` | `http://localhost:3002` | Your minicrawl server |
| `MINICRAWL_API_KEY` | – | Your minicrawl API key |

## Tools

| Tool | What it does |
|---|---|
| `minicrawl_scrape` | A page or file (PDF, Office, image) → markdown; optional screenshot, browser actions, AI JSON |
| `minicrawl_map` | List a site's URLs, ranked by a search term |
| `minicrawl_search` | Web search, optionally with each result's content |
| `minicrawl_crawl` / `minicrawl_crawl_status` | Crawl a site in the background, then read the pages |
| `minicrawl_extract` / `minicrawl_extract_status` | Structured JSON from pages with AI (needs `ANTHROPIC_API_KEY` on the server) |

## Troubleshooting

Errors are written to stderr; Claude Desktop shows them under **Settings → Developer → minicrawl → logs**.

- `Cannot connect to minicrawl … API key was rejected`: check `MINICRAWL_API_KEY`.
- `Cannot connect to minicrawl … is the server running`: check `MINICRAWL_API_URL`, and that `curl <url>/health` works.

License: AGPL-3.0.
