# Integrations

Use minicrawl from AI agents (MCP), RAG frameworks (LangChain, LlamaIndex), Firecrawl SDKs and automation tools.

- [AI agents via MCP](#ai-agents-via-mcp): Claude Code, Claude Desktop, Cursor, VS Code, any MCP client
- [Python, LangChain and LlamaIndex](#python-langchain-and-llamaindex)
- [Firecrawl SDKs](#firecrawl-sdks)
- [n8n, Make, Zapier and other HTTP tools](#n8n-make-zapier-and-other-http-tools)

All examples assume minicrawl at `http://localhost:3002` and your API key from `.env` (`API_KEY`). Replace `YOUR_KEY` with it.

---

## AI agents via MCP

minicrawl has a built-in **MCP server** at `POST /mcp` ([Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http), stateless). It is protected by the same API key as the REST API. Once connected, an agent can read pages, crawl docs, search the web and extract data on its own.

### Tools

| Tool | Arguments | Returns |
|---|---|---|
| `minicrawl_scrape` | `url`, `formats`, `onlyMainContent`, `waitFor`, `timeout`, `actions`, `jsonOptions`, `maxChars` | Page markdown with title/URL/status. Screenshots come back as images. Handles PDFs, Office files and images too |
| `minicrawl_map` | `url`, `search`, `limit` (default 100) | The site's URLs, ranked by `search` |
| `minicrawl_search` | `query`, `limit` (default 5), `tbs`, `scrape`, `maxChars` | Results; with `scrape: true`, each result's markdown |
| `minicrawl_crawl` | `url`, `limit` (default 10), `maxDepth`, `includePaths`, `excludePaths`, `crawlEntireDomain` | A crawl id (the crawl runs in the background) |
| `minicrawl_crawl_status` | `id`, `skip`, `maxChars` | Progress and the pages scraped so far |
| `minicrawl_extract` | `urls` (`site/*` allowed), `prompt`, `schema`, `enableWebSearch` | Structured JSON (waits up to 2 min; needs `ANTHROPIC_API_KEY`) |
| `minicrawl_extract_status` | `id` | The result of a long extraction |

Long pages are truncated to `maxChars` (default 50,000 characters, set by `MCP_MAX_CHARS`) so they don't flood the model's context. Agents can ask for more.

### Claude Code

```bash
claude mcp add --transport http minicrawl http://localhost:3002/mcp --header "Authorization: Bearer YOUR_KEY"
```

Add `--scope user` to make it available in all your projects. Then ask, for example: *"Use minicrawl to read https://docs.python.org/3/library/asyncio-task.html and summarize task groups."*

### Cursor

`~/.cursor/mcp.json` (all projects), or `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "minicrawl": {
      "url": "http://localhost:3002/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY" }
    }
  }
}
```

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "minicrawl": {
      "type": "http",
      "url": "http://localhost:3002/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY" }
    }
  }
}
```

### Claude Desktop (and other apps that only run local MCP servers)

Use the **`minicrawl-mcp`** bridge ([`integrations/mcp`](../integrations/mcp)). It runs locally and forwards to your server. In **Settings → Developer → Edit Config** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "minicrawl": {
      "command": "npx",
      "args": ["-y", "minicrawl-mcp"],
      "env": {
        "MINICRAWL_API_URL": "http://localhost:3002",
        "MINICRAWL_API_KEY": "YOUR_KEY"
      }
    }
  }
}
```

Restart Claude Desktop. To use the bridge straight from a clone of this repository instead of npm, run `npm install` in `integrations/mcp`, then use `"command": "node"` and `"args": ["/full/path/to/minicrawl/integrations/mcp/index.js"]`.

### Any other MCP client

- **Remote / HTTP clients:** URL `http://<server>:3002/mcp`, header `Authorization: Bearer <key>`.
- **stdio-only clients:** command `npx -y minicrawl-mcp` with the two environment variables above.

> [!TIP]
> If minicrawl runs on another machine, use its address instead of `localhost`. For anything beyond your own network, put it behind HTTPS (see [SELF_HOSTING.md](SELF_HOSTING.md#exposing-it-on-the-internet-https)).

---

## Python, LangChain and LlamaIndex

The **`minicrawl`** Python package ([`integrations/python`](../integrations/python)) is a small client plus integrations:

```bash
pip install "minicrawl-py[langchain]"   # or [llama-index], or just minicrawl-py
export MINICRAWL_API_URL=http://localhost:3002 MINICRAWL_API_KEY=YOUR_KEY
```

**LangChain:** a document loader with `scrape`, `crawl`, `map` and `search` modes:

```python
from minicrawl.langchain import MinicrawlLoader

docs = MinicrawlLoader("https://docs.example.com", mode="crawl", params={"limit": 50}).load()
# -> Document(page_content=<markdown>, metadata={"title", "url", "source", ...}) per page
```

**LlamaIndex:** a reader:

```python
from llama_index.core import VectorStoreIndex
from minicrawl.llama_index import MinicrawlReader

documents = MinicrawlReader().load_data(url="https://docs.example.com", mode="crawl", params={"limit": 50})
index = VectorStoreIndex.from_documents(documents)
```

**Plain client:**

```python
from minicrawl import Minicrawl

mc = Minicrawl()
print(mc.scrape("https://example.com")["markdown"])
```

Full reference: [integrations/python/README.md](../integrations/python/README.md).

---

## Firecrawl SDKs

minicrawl implements Firecrawl's v1 API, so the official JavaScript SDK's v1 client works when you point it at your server:

```js
import { FirecrawlAppV1 } from "@mendable/firecrawl-js";
const app = new FirecrawlAppV1({ apiKey: "YOUR_KEY", apiUrl: "http://localhost:3002" });
```

The tested methods are listed in [SELF_HOSTING.md](SELF_HOSTING.md#sdk-compatibility). Tools that let you set a "Firecrawl API URL" for v1 can usually point at minicrawl too.

---

## n8n, Make, Zapier and other HTTP tools

minicrawl is a plain JSON REST API, so any **HTTP Request** step works. In **n8n**:

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `http://minicrawl:3002/v1/scrape` (or `http://localhost:3002/...`) |
| Authentication | Generic → Header Auth: name `Authorization`, value `Bearer YOUR_KEY` |
| Body (JSON) | `{ "url": "{{ $json.url }}", "formats": ["markdown"] }` |

The page content is at `data.markdown` in the response. For crawls:
1. `POST /v1/crawl` → `id`
2. a **Wait** node
3. `GET /v1/crawl/{{id}}` until `status` is `completed`

If n8n runs in Docker on the same machine, add it to minicrawl's compose network, or use `http://host.docker.internal:3002`.

Import **`/openapi.json`** into tools that understand OpenAPI (Postman, Insomnia, Bruno, many low-code platforms) to get every endpoint pre-configured.
