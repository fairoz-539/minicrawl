"""LangChain document loader for minicrawl.

    from minicrawl.langchain import MinicrawlLoader

    docs = MinicrawlLoader("https://docs.example.com", mode="crawl", params={"limit": 20}).load()

Install with: ``pip install "minicrawl-py[langchain]"``
"""

from __future__ import annotations

from typing import Any, Dict, Iterator, Literal, Optional

from langchain_core.document_loaders import BaseLoader
from langchain_core.documents import Document

from .client import Minicrawl

Mode = Literal["scrape", "crawl", "map", "search"]


class MinicrawlLoader(BaseLoader):
    """Load web pages, PDFs and Office files as LangChain Documents via a minicrawl server.

    Args:
        url: The URL to scrape / crawl / map, or the query for ``mode="search"``.
        mode: ``scrape`` (one page), ``crawl`` (whole site), ``map`` (URLs only,
            one Document per URL), or ``search`` (web search, each result scraped).
        params: Extra request fields for that endpoint (see docs/API.md), e.g.
            ``{"limit": 20, "includePaths": ["^/docs/"]}`` for crawl.
        api_url / api_key: Server and key. Default to ``MINICRAWL_API_URL`` / ``MINICRAWL_API_KEY``.
        client: An existing :class:`Minicrawl` client to reuse instead.
    """

    def __init__(
        self,
        url: str,
        mode: Mode = "scrape",
        params: Optional[Dict[str, Any]] = None,
        api_url: Optional[str] = None,
        api_key: Optional[str] = None,
        client: Optional[Minicrawl] = None,
    ):
        if mode not in ("scrape", "crawl", "map", "search"):
            raise ValueError(f"Unknown mode {mode!r}: use scrape, crawl, map or search")
        self.url = url
        self.mode = mode
        self.params = dict(params or {})
        self.client = client or Minicrawl(api_url=api_url, api_key=api_key)

    @staticmethod
    def _to_document(doc: Dict[str, Any]) -> Document:
        metadata = dict(doc.get("metadata") or {})
        metadata.setdefault("source", metadata.get("url") or metadata.get("sourceURL"))
        return Document(page_content=doc.get("markdown") or "", metadata=metadata)

    def lazy_load(self) -> Iterator[Document]:
        if self.mode == "scrape":
            yield self._to_document(self.client.scrape(self.url, **self.params))
        elif self.mode == "crawl":
            crawl_id = self.client.start_crawl(self.url, **self.params)
            for doc in self.client.iter_crawl(crawl_id):
                yield self._to_document(doc)
        elif self.mode == "map":
            for link in self.client.map(self.url, **self.params):
                yield Document(page_content=link, metadata={"source": link})
        else:
            params = {"scrapeOptions": {"formats": ["markdown"]}, **self.params}
            for result in self.client.search(self.url, **params):
                doc = self._to_document(result)
                doc.metadata.setdefault("title", result.get("title"))
                doc.metadata.setdefault("description", result.get("description"))
                doc.metadata["source"] = result.get("url")
                if not doc.page_content:
                    doc.page_content = result.get("description") or ""
                yield doc
