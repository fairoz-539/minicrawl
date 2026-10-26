"""Starts a minicrawl server (fixture site, mock Claude, fixture SearXNG) for the
firecrawl-py contract tests. Reuses the Python package's test server helper."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

SERVE = Path(__file__).resolve().parents[2] / "integrations" / "python" / "tests" / "serve.mjs"


@pytest.fixture(scope="session")
def server():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is needed to start a minicrawl server for these tests")
    proc = subprocess.Popen(
        [node, "--disable-warning=ExperimentalWarning", str(SERVE)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    line = proc.stdout.readline()
    if not line:
        proc.kill()
        pytest.fail("minicrawl test server did not start")
    yield json.loads(line)
    proc.stdin.close()
    proc.wait(timeout=30)


@pytest.fixture()
def fc(server):
    from firecrawl import Firecrawl

    return Firecrawl(api_key=server["key"], api_url=server["api"])
