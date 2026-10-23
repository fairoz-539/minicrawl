"""LlamaIndex reader for minicrawl.

    from minicrawl.llama_index import MinicrawlReader

    documents = MinicrawlReader().load_data(url="https://docs.example.com", mode="crawl", params={"limit": 20})
    index = VectorStoreIndex.from_documents(documents)

Install with: ``pip install "minicrawl-py[llama-index]"``
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

from llama_index.core.readers.base import BaseReader
from llama_index.core.schema import Document

from .client import Minicrawl


class MinicrawlReader(BaseReader):
    """Read web pages, PDFs and Office files into LlamaIndex Documents via a minicrawl server.

    Args:
        api_url / api_key: Server and key. Default to ``MINICRAWL_API_URL`` / ``MINICRAWL_API_KEY``.
        client: An existing :class:`Minicrawl` client to reuse instead.
    """

    def __init__(self, api_url: Optional[str] = None, api_key: Optional[str] = None, client: Optional[Minicrawl] = None):
        self.client = client or Minicrawl(api_url=api_url, api_key=api_key)

    @staticmethod
    def _to_document(doc: Dict[str, Any]) -> Document:
        metadata = {k: v for k, v in (doc.get("metadata") or {}).items() if isinstance(v, (str, int, float, bool))}
        metadata.setdefault("url", metadata.get("sourceURL"))
        return Document(text=doc.get("markdown") or "", metadata=metadata)

    def lazy_load_data(
        self,
        url: Optional[str] = None,
        urls: Optional[List[str]] = None,
        query: Optional[str] = None,
        mode: str = "scrape",
        params: Optional[Dict[str, Any]] = None,
    ) -> Iterable[Document]:
        """Yield Documents.

        Args:
            url / urls: Page(s) to scrape, or the site to crawl / map.
            query: Search query (``mode="search"``).
            mode: ``scrape``, ``crawl``, ``map`` (one Document per URL) or ``search``.
            params: Extra request fields for that endpoint (see docs/API.md).
        """
        params = dict(params or {})
        targets = urls or ([url] if url else [])
        if mode == "scrape":
            for target in targets:
                yield self._to_document(self.client.scrape(target, **params))
        elif mode == "crawl":
            for target in targets:
                for doc in self.client.iter_crawl(self.client.start_crawl(target, **params)):
                    yield self._to_document(doc)
        elif mode == "map":
            for target in targets:
                for link in self.client.map(target, **params):
                    yield Document(text=link, metadata={"url": link})
        elif mode == "search":
            if not query:
                raise ValueError('mode="search" needs query=')
            params = {"scrapeOptions": {"formats": ["markdown"]}, **params}
            for result in self.client.search(query, **params):
                doc = self._to_document(result)
                doc.metadata["url"] = result.get("url")
                doc.metadata["title"] = result.get("title") or doc.metadata.get("title")
                yield doc
        else:
            raise ValueError(f"Unknown mode {mode!r}: use scrape, crawl, map or search")
