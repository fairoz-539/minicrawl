// Local stand-ins for external services used in tests:
//  - an Anthropic Messages API (SSE streaming) that records requests
//  - an HTTP forward proxy that tags requests it relays
import http from "node:http";
import net from "node:net";

export function startMockAnthropic() {
  const state = { requests: [], reply: { ok: true }, mode: "ok" };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    state.requests.push({ path: req.url, headers: req.headers, body });

    if (state.mode === "unauthorized") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    }
    const stopReason = state.mode === "refusal" ? "refusal" : "end_turn";
    const text = state.mode === "refusal" ? "" : JSON.stringify(typeof state.reply === "function" ? state.reply(body) : state.reply);
    const message = {
      id: "msg_test", type: "message", role: "assistant", model: body.model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 },
    };
    const events = [
      ["message_start", { type: "message_start", message }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null, ...(stopReason === "refusal" ? { stop_details: { type: "refusal", category: null, explanation: "test" } } : {}) },
          usage: { output_tokens: 20 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ];
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });

  return new Promise(resolve =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise(r => server.close(r)) }),
    ),
  );
}

/**
 * Forward proxy (CONNECT tunnels and absolute-URI requests). Its outbound
 * connections come from 127.0.0.2, so the fixture site can tell proxied
 * traffic apart from direct traffic (127.0.0.1).
 */
export const PROXY_EGRESS_ADDRESS = "127.0.0.2";

export function startForwardProxy() {
  const state = { hits: 0 };
  const server = http.createServer((req, res) => {
    state.hits++;
    const target = new URL(req.url);
    const upstream = http.request(
      target,
      { method: req.method, headers: { ...req.headers, host: target.host }, localAddress: PROXY_EGRESS_ADDRESS },
      up => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on("connect", (req, client, head) => {
    state.hits++;
    const [host, port] = req.url.split(":");
    const upstream = net.connect({ host, port: Number(port), localAddress: PROXY_EGRESS_ADDRESS }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  return new Promise(resolve =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise(r => server.close(r)) }),
    ),
  );
}
