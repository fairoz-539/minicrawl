"""HTTP client for the minicrawl REST API (see docs/API.md)."""

from __future__ import annotations

import os
import time
from typing import Any, Dict, Iterator, List, Optional

import httpx

DEFAULT_URL = "http://localhost:3002"


class MinicrawlError(Exception):
    """An error response from minicrawl, with its stable ``code`` (e.g. ``BLOCKED_BY_SITE``)."""

    def __init__(self, message: str, code: Optional[str] = None, status: Optional[int] = None):
        super().__init__(message)
        self.code = code
        self.status = status

    def __str__(self) -> str:  # pragma: no cover - trivial
        prefix = f"[{self.status} {self.code}] " if self.code else ""
        return prefix + super().__str__()


class Minicrawl:
    """Client for a minicrawl server.

    Args:
        api_url: Server URL. Defaults to ``MINICRAWL_API_URL`` or ``http://localhost:3002``.
        api_key: API key. Defaults to ``MINICRAWL_API_KEY``.
        timeout: Seconds to wait for each HTTP response (scrapes can take a while).
    """

    def __init__(self, api_url: Optional[str] = None, api_key: Optional[str] = None, timeout: float = 120.0):
        self.api_url = (api_url or os.environ.get("MINICRAWL_API_URL") or DEFAULT_URL).rstrip("/")
        key = api_key if api_key is not None else os.environ.get("MINICRAWL_API_KEY", "")
        headers = {"Authorization": f"Bearer {key}"} if key else {}
        self._http = httpx.Client(base_url=self.api_url, headers=headers, timeout=timeout)

    # -- plumbing -------------------------------------------------------------

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "Minicrawl":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _request(self, method: str, path: str, json: Any = None, params: Any = None) -> Any:
        try:
            r = self._http.request(method, path, json=json, params=params)
        except httpx.HTTPError as e:
            raise MinicrawlError(f"Cannot reach minicrawl at {self.api_url}: {e}") from e
        try:
            body = r.json()
        except ValueError:
            body = {"error": r.text}
        if r.status_code >= 400 or body.get("success") is False and "status" not in body:
            raise MinicrawlError(body.get("error") or f"HTTP {r.status_code}", body.get("code"), r.status_code)
        return body

    @staticmethod
    def _drop_none(d: Dict[str, Any]) -> Dict[str, Any]:
        return {k: v for k, v in d.items() if v is not None}

    # -- endpoints -------------------------------------------------------------

    def health(self) -> Dict[str, Any]:
        """Server status and enabled features (``GET /health``)."""
        return self._request("GET", "/health")

    def scrape(self, url: str, **options: Any) -> Dict[str, Any]:
        """Scrape one URL. Options are the /v1/scrape fields, e.g.
        ``formats=["markdown", "links"]``, ``actions=[...]``, ``jsonOptions={...}``.
        Returns the document: ``markdown``, ``metadata``, ...
        """
        return self._request("POST", "/v1/scrape", json={"url": url, **options})["data"]

    def map(self, url: str, **options: Any) -> List[str]:
        """List a site's URLs. Options: ``search``, ``limit``, ``includeSubdomains``, ..."""
        return self._request("POST", "/v1/map", json={"url": url, **options})["links"]

    def search(self, query: str, **options: Any) -> List[Dict[str, Any]]:
        """Web search. Pass ``scrapeOptions={"formats": ["markdown"]}`` to also get each page's content."""
        return self._request("POST", "/v1/search", json={"query": query, **options})["data"]

    def start_crawl(self, url: str, **options: Any) -> str:
        """Start a crawl and return its id. Options are the /v1/crawl fields (``limit``, ``includePaths``, ...)."""
        return self._request("POST", "/v1/crawl", json={"url": url, **options})["id"]

    def crawl_status(self, crawl_id: str, skip: int = 0) -> Dict[str, Any]:
        """One page of crawl status (up to 100 documents)."""
        return self._request("GET", f"/v1/crawl/{crawl_id}", params={"skip": skip} if skip else None)

    def iter_crawl(self, crawl_id: str, poll_interval: float = 2.0, timeout: Optional[float] = None) -> Iterator[Dict[str, Any]]:
        """Yield documents as a crawl produces them, until it finishes."""
        deadline = time.monotonic() + timeout if timeout else None
        seen = 0
        while True:
            status = self.crawl_status(crawl_id, skip=seen)
            for doc in status["data"]:
                seen += 1
                yield doc
            if status["status"] != "scraping" and not status.get("next"):
                return
            if status["status"] == "scraping":
                if deadline and time.monotonic() > deadline:
                    raise MinicrawlError(f"Crawl {crawl_id} did not finish within {timeout}s", "TIMEOUT")
                time.sleep(poll_interval)

    def crawl(self, url: str, poll_interval: float = 2.0, timeout: Optional[float] = None, **options: Any) -> List[Dict[str, Any]]:
        """Crawl a site and return all documents when it's done."""
        return list(self.iter_crawl(self.start_crawl(url, **options), poll_interval, timeout))

    def cancel_crawl(self, crawl_id: str) -> None:
        self._request("DELETE", f"/v1/crawl/{crawl_id}")

    def crawl_errors(self, crawl_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/crawl/{crawl_id}/errors")

    def start_extract(self, urls: List[str], prompt: Optional[str] = None, schema: Optional[Dict[str, Any]] = None, **options: Any) -> str:
        body = self._drop_none({"urls": urls, "prompt": prompt, "schema": schema, **options})
        return self._request("POST", "/v1/extract", json=body)["id"]

    def extract_status(self, extract_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/extract/{extract_id}")

    def extract(
        self,
        urls: List[str],
        prompt: Optional[str] = None,
        schema: Optional[Dict[str, Any]] = None,
        poll_interval: float = 2.0,
        timeout: Optional[float] = 300.0,
        **options: Any,
    ) -> Any:
        """AI extraction across pages (needs ANTHROPIC_API_KEY on the server). Waits and returns the data."""
        job = self.start_extract(urls, prompt, schema, **options)
        deadline = time.monotonic() + timeout if timeout else None
        while True:
            status = self.extract_status(job)
            if status["status"] == "completed":
                return status["data"]
            if status["status"] == "failed":
                raise MinicrawlError(status.get("error") or "Extraction failed", "EXTRACT_FAILED")
            if deadline and time.monotonic() > deadline:
                raise MinicrawlError(f"Extraction {job} did not finish within {timeout}s", "TIMEOUT")
            time.sleep(poll_interval)
