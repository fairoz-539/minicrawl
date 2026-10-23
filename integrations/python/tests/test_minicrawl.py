import pytest

from minicrawl import Minicrawl, MinicrawlError


# -- client ----------------------------------------------------------------------


def test_health(client):
    health = client.health()
    assert health["status"] == "ok"
    assert health["auth"] is True


def test_scrape(client, server):
    page = client.scrape(f"{server['site']}/docs/a", formats=["markdown", "links"])
    assert "# Doc A" in page["markdown"]
    assert page["metadata"]["title"] == "Doc A"
    assert isinstance(page["links"], list)


def test_errors_carry_code_and_status(client, server):
    with pytest.raises(MinicrawlError) as e:
        client.scrape(f"{server['site']}/photo.jpg")
    assert e.value.code == "UNSUPPORTED_FILE"
    assert e.value.status == 422


def test_bad_key(server):
    with Minicrawl(api_url=server["api"], api_key="wrong-key") as c, pytest.raises(MinicrawlError) as e:
        c.scrape("https://example.com")
    assert e.value.status == 401


def test_env_configuration(server, monkeypatch):
    monkeypatch.setenv("MINICRAWL_API_URL", server["api"])
    monkeypatch.setenv("MINICRAWL_API_KEY", server["key"])
    with Minicrawl() as c:
        assert c.health()["status"] == "ok"


def test_map_search_crawl_extract(client, server):
    links = client.map(f"{server['site']}/", search="docs", limit=3)
    assert len(links) == 3 and all("/docs" in link for link in links)

    results = client.search("minicrawl", limit=2)
    assert [r["title"] for r in results] == ["Doc A", "About"]

    pages = client.crawl(f"{server['site']}/docs/", limit=3, poll_interval=0.3, timeout=60)
    assert len(pages) == 3

    data = client.extract([f"{server['site']}/docs/a", f"{server['site']}/docs/b"], prompt="title", poll_interval=0.3)
    assert data == {"title": "Doc A", "pages": 2}


# -- LangChain -----------------------------------------------------------------------


def test_langchain_loader(server):
    from minicrawl.langchain import MinicrawlLoader

    common = {"api_url": server["api"], "api_key": server["key"]}

    [doc] = MinicrawlLoader(f"{server['site']}/about", **common).load()
    assert "About us" in doc.page_content
    assert doc.metadata["source"].endswith("/about")

    crawled = MinicrawlLoader(f"{server['site']}/docs/", mode="crawl", params={"limit": 3}, **common).load()
    assert len(crawled) == 3 and all(d.page_content for d in crawled)

    mapped = MinicrawlLoader(f"{server['site']}/", mode="map", params={"limit": 5}, **common).load()
    assert all(d.page_content.startswith("http") for d in mapped)

    found = MinicrawlLoader("minicrawl", mode="search", params={"limit": 1}, **common).load()
    assert found[0].metadata["title"] == "Doc A"
    assert "# Doc A" in found[0].page_content


def test_langchain_rejects_unknown_mode(server):
    from minicrawl.langchain import MinicrawlLoader

    with pytest.raises(ValueError):
        MinicrawlLoader("https://example.com", mode="explode", api_url=server["api"])


# -- LlamaIndex ---------------------------------------------------------------------------


def test_llama_index_reader(server):
    from minicrawl.llama_index import MinicrawlReader

    reader = MinicrawlReader(api_url=server["api"], api_key=server["key"])

    docs = reader.load_data(urls=[f"{server['site']}/about", f"{server['site']}/docs/a"])
    assert len(docs) == 2
    assert "About us" in docs[0].text
    assert docs[1].metadata["title"] == "Doc A"

    crawled = reader.load_data(url=f"{server['site']}/docs/", mode="crawl", params={"limit": 3})
    assert len(crawled) == 3

    found = reader.load_data(query="minicrawl", mode="search", params={"limit": 1})
    assert found[0].metadata["title"] == "Doc A"
