import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).parent


@pytest.fixture(scope="session")
def server():
    """A running minicrawl (+ fixture site) for the whole test session."""
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is needed to start a minicrawl server for these tests")
    proc = subprocess.Popen(
        [node, "--disable-warning=ExperimentalWarning", str(HERE / "serve.mjs")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    line = proc.stdout.readline()
    if not line:
        proc.kill()
        pytest.fail("minicrawl test server did not start")
    info = json.loads(line)
    yield info
    proc.stdin.close()
    proc.wait(timeout=30)


@pytest.fixture()
def client(server):
    from minicrawl import Minicrawl

    with Minicrawl(api_url=server["api"], api_key=server["key"]) as c:
        yield c
