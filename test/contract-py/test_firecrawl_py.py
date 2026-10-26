"""Contract tests: the official firecrawl-py SDK (default v2 client `Firecrawl`)
against a real minicrawl server. If an SDK update changes what it sends or
expects, these fail."""
from urllib.parse import urlparse

import pytest
from firecrawl import Firecrawl


def path(url):
    return urlparse(url).path


def test_scrape_formats(fc, server):
    doc = fc.scrape(server["site"] + "/", formats=["markdown", "html", "links", "images"], only_main_content=True)
    assert "# Welcome home" in doc.markdown
    assert "Welcome home" in doc.html
    assert any(link.endswith("/about") for link in doc.links)
    assert isinstance(doc.images, list)
    assert doc.metadata.status_code == 200
    assert doc.metadata.title == "Home"


def test_scrape_json_format(fc, server):
    doc = fc.scrape(
        server["site"] + "/docs/a",
        formats=[{"type": "json", "prompt": "the title", "schema": {"type": "object", "properties": {"title": {"type": "string"}}}}],
    )
    # The mock model answers {"title": "Doc A", "pages": <pages it was given>}.
    assert doc.json["title"] == "Doc A"


def test_unsupported_format_is_an_error(fc, server):
    with pytest.raises(Exception) as err:
        fc.scrape(server["site"] + "/", formats=["branding"])
    assert "branding" in str(err.value)


def test_crawl_and_errors(fc, server):
    job = fc.crawl(server["site"] + "/", limit=5, poll_interval=1)
    assert job.status == "completed"
    assert 3 <= len(job.data) <= 5
    assert all(d.markdown for d in job.data)
    errors = fc.get_crawl_errors(job.id)
    assert any(path(u).startswith("/private") for u in errors.robots_blocked)


def test_start_crawl_active_and_cancel(fc, server):
    started = fc.start_crawl(server["site"] + "/", limit=50, sitemap="skip", delay=1)
    assert "/v2/crawl/" in started.url
    assert any(c.id == started.id for c in fc.get_active_crawls().crawls)
    assert fc.cancel_crawl(started.id) is True
    assert fc.get_crawl_status(started.id).status == "cancelled"


def test_batch_scrape(fc, server):
    site = server["site"]
    job = fc.batch_scrape([site + "/", site + "/about"], formats=["markdown"], poll_interval=1)
    assert job.status == "completed"
    assert sorted(path(d.metadata.source_url) for d in job.data) == ["/", "/about"]
    started = fc.start_batch_scrape([site + "/docs/a", "https://bad host/"], formats=["markdown"])
    assert started.invalid_urls == ["https://bad host/"]
    status = fc.get_batch_scrape_status(started.id)
    assert status.status in ("scraping", "completed")


def test_map(fc, server):
    fc.scrape(server["site"] + "/about")  # so the index knows its title
    res = fc.map(server["site"] + "/", limit=50)
    about = [link for link in res.links if path(link.url) == "/about"]
    assert about and about[0].title == "About"


def test_search_sources(fc, server):
    res = fc.search("minicrawl", sources=["web", "news", "images"], limit=5)
    assert res.web[0].title == "Doc A"
    assert res.news[0].title == "News A"
    assert res.images[0].image_width == 640


def test_extract(fc, server):
    res = fc.extract(urls=[server["site"] + "/docs/a"], prompt="the title", poll_interval=1)
    assert res.status == "completed"
    assert res.data["title"] == "Doc A"


def test_team_endpoints(fc):
    c = fc.get_concurrency()
    assert isinstance(c.concurrency, int) and c.max_concurrency > 0
    assert fc.get_credit_usage().remaining_credits > 0
    assert fc.get_token_usage().remaining_tokens > 0
    q = fc.get_queue_status()
    assert q.jobs_in_queue >= 0 and q.max_concurrency > 0


def test_wrong_key(server):
    bad = Firecrawl(api_key="wrong-key-0123456789abcdef", api_url=server["api"])
    with pytest.raises(Exception) as err:
        bad.scrape(server["site"] + "/")
    assert "401" in str(err.value) or "nauthorized" in str(err.value)
