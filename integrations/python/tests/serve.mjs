// Test helper: starts the fixture site and a minicrawl server (mock Claude, fixture
// SearXNG), then prints {"api", "site", "key"} as one JSON line. Stops on stdin close.
const root = new URL("../../../", import.meta.url);
process.env.ALLOW_PRIVATE_URLS = "true";
const KEY = "python-test-key-0123456789";
process.env.API_KEY = KEY;

const { startFixtureSite } = await import(new URL("test/fixture-site.js", root));
const { startMockAnthropic } = await import(new URL("test/mock-services.js", root));
const site = await startFixtureSite();
const llm = await startMockAnthropic();
llm.state.reply = body => ({ title: "Doc A", pages: body.messages[0].content.filter(b => b.text?.startsWith("<page")).length });
process.env.ANTHROPIC_BASE_URL = llm.url;
process.env.ANTHROPIC_API_KEY = "test";
process.env.SEARXNG_ENDPOINT = site.url + "/searx";

const { start } = await import(new URL("src/server.js", root));
const api = await start({ port: 0, host: "127.0.0.1", workers: 2, dbPath: ":memory:" });
console.log(JSON.stringify({ api: `http://127.0.0.1:${api.port}`, site: site.url, key: KEY }));

const stop = async () => {
  await api.close();
  await Promise.all([site.close(), llm.close()]);
  process.exit(0);
};
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.resume();
