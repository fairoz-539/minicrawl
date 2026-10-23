"""Python client for minicrawl, the self-hosted, Firecrawl-compatible scraping API.

    from minicrawl import Minicrawl

    mc = Minicrawl()  # MINICRAWL_API_URL / MINICRAWL_API_KEY from the environment
    page = mc.scrape("https://example.com")
    print(page["markdown"])

Integrations: ``minicrawl.langchain.MinicrawlLoader``, ``minicrawl.llama_index.MinicrawlReader``.
"""

from .client import Minicrawl, MinicrawlError

__all__ = ["Minicrawl", "MinicrawlError"]
__version__ = "1.0.0"
