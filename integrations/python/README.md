# minicrawl-py

Python client for **[minicrawl](https://github.com/fairoz-539/minicrawl)**, the self-hosted, Firecrawl-compatible scraping API, with **LangChain** and **LlamaIndex** integrations.

You need a running minicrawl server (see the [quick start](https://github.com/fairoz-539/minicrawl#-quick-start)) and its API key.

```bash
pip install minicrawl-py                 # client only
pip install "minicrawl-py[langchain]"    # + LangChain loader
pip install "minicrawl-py[llama-index]"  # + LlamaIndex reader
```

It installs as `minicrawl-py` and imports as `minicrawl`: `from minicrawl import Minicrawl`.

Configure it with arguments, or with the environment:

```bash
export MINICRAWL_API_URL=http://localhost:3002
export MINICRAWL_API_KEY=your-minicrawl-api-key
```

## Client

```python
from minicrawl import Minicrawl, MinicrawlError

mc = Minicrawl()   # or Minicrawl(api_url="http://localhost:3002", api_key="...")

page = mc.scrape("https://example.com")
print(page["markdown"], page["metadata"]["title"])

links = mc.map("https://docs.python.org/3/", search="asyncio", limit=20)
results = mc.search("self-hosted web scraping", limit=5, scrapeOptions={"formats": ["markdown"]})
pages = mc.crawl("https://books.toscrape.com", limit=20, crawlEntireDomain=True)

# Stream pages while a crawl runs
for doc in mc.iter_crawl(mc.start_crawl("https://books.toscrape.com", limit=50)):
    print(doc["metadata"]["url"])

# AI extraction (needs ANTHROPIC_API_KEY on the server)
data = mc.extract(["https://books.toscrape.com/*"], prompt="List book titles and prices")

try:
    mc.scrape("https://example.com/file.zip")
except MinicrawlError as e:
    print(e.status, e.code)   # 422 UNSUPPORTED_FILE
```

Keyword arguments are passed through as the API's request fields, so every option in the [API reference](https://github.com/fairoz-539/minicrawl/blob/main/docs/API.md) works: `formats`, `actions`, `jsonOptions`, `includePaths`, `proxy`, …

## LangChain

```python
from minicrawl.langchain import MinicrawlLoader

docs = MinicrawlLoader("https://example.com").load()                          # one page
docs = MinicrawlLoader("https://docs.example.com", mode="crawl",
                       params={"limit": 50, "includePaths": ["^/guide/"]}).load()  # a site
docs = MinicrawlLoader("vector databases comparison", mode="search",
                       params={"limit": 5}).load()                             # web search
```

| Mode | Documents |
|---|---|
| `scrape` | One document for the page (also PDFs, Office files, images) |
| `crawl` | One per crawled page (`lazy_load()` streams them while the crawl runs) |
| `map` | One per URL on the site (`page_content` is the URL) |
| `search` | One per search result, with the page's markdown |

`metadata` holds the page metadata (`title`, `url`, `statusCode`, …) plus `source`.

## LlamaIndex

```python
from llama_index.core import VectorStoreIndex
from minicrawl.llama_index import MinicrawlReader

reader = MinicrawlReader()
documents = reader.load_data(url="https://docs.example.com", mode="crawl", params={"limit": 50})
index = VectorStoreIndex.from_documents(documents)
```

`load_data(url=..., urls=[...], query=..., mode="scrape"|"crawl"|"map"|"search", params={...})`

## Development

```bash
pip install -e ".[dev]"
pytest          # starts a real minicrawl server (needs Node.js and the repo's npm install)
```

License: AGPL-3.0, like minicrawl.
