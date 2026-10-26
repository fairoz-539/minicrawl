// AI extraction: the `json` and `summary` scrape formats and /v1/extract.
// Firecrawl does this with OpenAI-style generateObject (transformers/llmExtract.ts).
//
// Two providers (LLM_PROVIDER):
//  - anthropic (default): Claude structured outputs (output_config.format
//    json_schema). Credentials: ANTHROPIC_API_KEY.
//  - openai: any OpenAI-compatible chat completions server, typically one you
//    run yourself: Ollama, vLLM, LM Studio, llama.cpp. LLM_BASE_URL (e.g.
//    http://localhost:11434/v1), LLM_MODEL, optional LLM_API_KEY. Chosen
//    automatically when LLM_BASE_URL is set.
import Anthropic from "@anthropic-ai/sdk";

export const PROVIDER = (process.env.LLM_PROVIDER ?? (process.env.LLM_BASE_URL ? "openai" : "anthropic")).toLowerCase();
const OPENAI = PROVIDER === "openai";
const BASE_URL = (process.env.LLM_BASE_URL ?? "").replace(/\/+$/, "");
const MODEL = process.env.LLM_MODEL ?? (OPENAI ? "" : "claude-opus-5-5");
const EFFORT = process.env.LLM_EFFORT ?? "medium";
// Local models have much smaller context windows than Claude: smaller batches by default.
const MAX_INPUT_CHARS = Number(process.env.LLM_MAX_INPUT_CHARS ?? (OPENAI ? 200_000 : 1_500_000)); // ~375k tokens for Claude
const BATCH_CHARS = Number(process.env.LLM_BATCH_CHARS ?? (OPENAI ? 40_000 : 400_000));
const MAX_OUTPUT_TOKENS = Number(process.env.LLM_MAX_OUTPUT_TOKENS ?? (OPENAI ? 8192 : 64_000));
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 300_000);
if (!["anthropic", "openai"].includes(PROVIDER)) throw new Error(`Unknown LLM_PROVIDER "${PROVIDER}": use anthropic or openai`);

/** For /health: whether AI extraction can work, and with what. */
export function llmStatus() {
  const configured = OPENAI ? !!(BASE_URL && MODEL) : !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return { configured, provider: PROVIDER, model: MODEL || null };
}
// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const NO_EFFORT_MODELS = /haiku-4-5|sonnet-4-5/;

export class LLMError extends Error {
  constructor(message, code, status = 502) {
    super(message);
    this.name = "LLMError";
    this.code = code;
    this.status = status;
  }
}

let client = null;
function getClient() {
  if (!client) {
    try {
      client = new Anthropic();
    } catch (err) {
      throw new LLMError(`AI extraction is not configured: ${err.message}`, "LLM_NOT_CONFIGURED", 503);
    }
  }
  return client;
}

const UNSUPPORTED_KEYWORDS = [
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems",
  "minProperties", "maxProperties", "$schema", "$id", "examples", "default",
];
const SUPPORTED_FORMATS = new Set([
  "date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid",
]);

/**
 * Make a user's JSON Schema acceptable to structured outputs: drop the
 * constraints it doesn't support, close every object, and require every
 * property (optional ones become nullable so the model can say "not found").
 */
export function toStructuredSchema(schema) {
  const walk = node => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (UNSUPPORTED_KEYWORDS.includes(k)) continue;
      if (k === "format" && !SUPPORTED_FORMATS.has(v)) continue;
      out[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, walk(s)])) : walk(v);
    }
    const isObject = out.type === "object" || (Array.isArray(out.type) && out.type.includes("object")) || out.properties;
    if (isObject) {
      out.type ??= "object";
      out.properties ??= {};
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      for (const [p, s] of Object.entries(out.properties)) {
        if (!required.has(p)) out.properties[p] = { anyOf: [s, { type: "null" }] };
      }
      out.required = Object.keys(out.properties);
      out.additionalProperties = false;
    }
    return out;
  };
  // Structured outputs wants an object at the root; wrap anything else.
  if (schema?.type !== "object" && !schema?.properties) {
    return walk({ type: "object", properties: { result: schema ?? {} }, required: ["result"] });
  }
  return walk(schema);
}

const SYSTEM = `You extract structured data from web pages for a scraping API.
Use only information present in the provided page content. Do not invent values.
When a field cannot be found in the content, use null (or an empty array for lists).
Keep values as they appear on the page (prices, names, dates), normalized only as the schema requires.`;

function parseJsonText(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[[{]/);
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new LLMError("The model did not return valid JSON", "LLM_BAD_JSON");
  }
}

async function callClaude({ system, userBlocks, schema }) {
  const params = {
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system,
    messages: [{ role: "user", content: userBlocks }],
    ...(schema || !NO_EFFORT_MODELS.test(MODEL)
      ? {
          output_config: {
            ...(NO_EFFORT_MODELS.test(MODEL) ? {} : { effort: EFFORT }),
            ...(schema ? { format: { type: "json_schema", schema } } : {}),
          },
        }
      : {}),
  };

  const api = getClient();
  let message;
  try {
    // Streaming: page content can be long, and it avoids HTTP timeouts.
    message = FALLBACK_MODELS.has(MODEL) && process.env.LLM_FALLBACKS !== "false"
      ? await api.beta.messages
          .stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
          .finalMessage()
      : await api.messages.stream(params).finalMessage();
  } catch (err) {
    if (err instanceof LLMError) throw err;
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new LLMError("AI extraction is not configured: set ANTHROPIC_API_KEY", "LLM_NOT_CONFIGURED", 503);
    }
    if (err instanceof Anthropic.RateLimitError) throw new LLMError("LLM rate limit reached; retry later", "LLM_RATE_LIMITED", 429);
    if (err instanceof Anthropic.BadRequestError) throw new LLMError(`LLM rejected the request: ${err.message}`, "LLM_BAD_REQUEST", 400);
    if (err instanceof Anthropic.APIError) throw new LLMError(`LLM error ${err.status ?? ""}: ${err.message}`, "LLM_ERROR");
    if (err instanceof Anthropic.AnthropicError) {
      throw new LLMError(`AI extraction is not configured or unreachable: ${err.message}`, "LLM_NOT_CONFIGURED", 503);
    }
    throw err;
  }

  if (message.stop_reason === "refusal") {
    throw new LLMError(
      `The model declined to extract this content${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}`,
      "LLM_REFUSAL",
      422,
    );
  }
  if (message.stop_reason === "max_tokens") {
    throw new LLMError("The extracted data was too large for one response", "LLM_OUTPUT_TOO_LARGE", 422);
  }
  const text = message.content.filter(b => b.type === "text").map(b => b.text).join("");
  return {
    data: parseJsonText(text),
    usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, model: message.model },
  };
}

// --- OpenAI-compatible servers ------------------------------------------------

/**
 * How to ask for JSON, tried in order until the server accepts one. Servers
 * differ: Ollama, vLLM, LM Studio and llama.cpp take json_schema; some only
 * json_object; a few neither. The first one that works is remembered.
 */
const RESPONSE_FORMATS = ["json_schema", "json_object", "none"];
let workingFormat = null;
/** Tests only: forget which response_format the server accepted. */
export const resetFormatProbe = () => (workingFormat = null);

function responseFormat(kind, schema) {
  if (kind === "json_schema" && schema) return { type: "json_schema", json_schema: { name: "extraction", schema, strict: true } };
  if (kind === "json_schema" || kind === "json_object") return { type: "json_object" };
  return undefined;
}

/** Reasoning models (Qwen 3, DeepSeek R1, …) may think out loud before answering. */
const stripThinking = text => text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

async function postChat(body) {
  if (!BASE_URL || !MODEL) {
    throw new LLMError("AI extraction is not configured: set LLM_BASE_URL and LLM_MODEL", "LLM_NOT_CONFIGURED", 503);
  }
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.LLM_API_KEY ? { authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === "TimeoutError") throw new LLMError(`The model did not answer within ${TIMEOUT_MS} ms`, "LLM_TIMEOUT", 504);
    throw new LLMError(`Can't reach the LLM server at ${BASE_URL}: ${err.cause?.code ?? err.message}`, "LLM_NOT_CONFIGURED", 503);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

function openaiError(status, json, text) {
  const msg = json?.error?.message ?? json?.error ?? text.slice(0, 300);
  if (status === 401 || status === 403) return new LLMError(`The LLM server refused the credentials: ${msg}`, "LLM_NOT_CONFIGURED", 503);
  if (status === 404) {
    return new LLMError(`Model "${MODEL}" not found on ${BASE_URL} (with Ollama: ollama pull ${MODEL}): ${msg}`, "LLM_NOT_CONFIGURED", 503);
  }
  if (status === 429) return new LLMError("LLM rate limit reached; retry later", "LLM_RATE_LIMITED", 429);
  return new LLMError(`LLM error ${status}: ${msg}`, "LLM_ERROR");
}

/** Top-level keys the schema requires that the result lacks. */
function missingKeys(data, schema) {
  if (!schema?.required || !data || typeof data !== "object" || Array.isArray(data)) return [];
  return schema.required.filter(k => !(k in data));
}

async function callOpenAI({ system, userBlocks, schema }) {
  const messages = [
    { role: "system", content: schema ? `${system}\n\nReply with JSON matching this schema:\n${JSON.stringify(schema)}` : system },
    { role: "user", content: userBlocks.map(b => b.text).join("\n\n") },
  ];
  const usage = { inputTokens: 0, outputTokens: 0, model: MODEL };

  const ask = async msgs => {
    const formats = workingFormat ? [workingFormat] : RESPONSE_FORMATS;
    let last;
    for (const kind of formats) {
      const format = responseFormat(kind, schema);
      const { status, json, text } = await postChat({
        model: MODEL,
        messages: msgs,
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
        ...(format ? { response_format: format } : {}),
      });
      // 400/422 on a response_format the server doesn't know: try the next way.
      if ((status === 400 || status === 422) && format && !workingFormat) {
        last = openaiError(status, json, text);
        continue;
      }
      if (status !== 200) throw openaiError(status, json, text);
      workingFormat ??= kind;
      const choice = json?.choices?.[0];
      usage.inputTokens += json?.usage?.prompt_tokens ?? 0;
      usage.outputTokens += json?.usage?.completion_tokens ?? 0;
      if (choice?.finish_reason === "length") {
        throw new LLMError("The extracted data was too large for one response (raise LLM_MAX_OUTPUT_TOKENS)", "LLM_OUTPUT_TOO_LARGE", 422);
      }
      return stripThinking(choice?.message?.content ?? "");
    }
    throw last;
  };

  let reply = await ask(messages);
  let data;
  let problem = null;
  try {
    data = parseJsonText(reply);
    const missing = missingKeys(data, schema);
    if (missing.length) problem = `It was missing these fields: ${missing.join(", ")}.`;
  } catch {
    problem = "It was not valid JSON.";
  }
  // Smaller models sometimes slip: one corrective retry.
  if (problem) {
    reply = await ask([
      ...messages,
      { role: "assistant", content: reply },
      { role: "user", content: `${problem} Reply again with only the JSON object${schema ? " matching the schema, every field present (null when not found)" : ""}.` },
    ]);
    data = parseJsonText(reply);
  }
  return { data, usage };
}

const callModel = args => (OPENAI ? callOpenAI(args) : callClaude(args));

function instruction({ prompt, schema }) {
  if (schema && prompt) return `Extract the data described by the JSON schema. Instructions: ${prompt}`;
  if (schema) return "Extract the data described by the JSON schema from the page content above.";
  return `${prompt}\n\nReply with only a JSON object containing the extracted data, no prose.`;
}

const pageBlock = (doc, cap) => {
  const md = doc.markdown ?? "";
  return {
    type: "text",
    text: `<page url="${doc.url}"${doc.title ? ` title="${doc.title.replace(/"/g, "'")}"` : ""}>\n${md.length > cap ? md.slice(0, cap) : md}\n</page>`,
  };
};

/**
 * Extract JSON from one or more scraped documents ({url, title, markdown}).
 * Large inputs are split into batches whose partial results are merged.
 * @returns {{data: any, warnings: string[], usage: object[]}}
 */
export async function extractJson(docs, { schema, prompt, systemPrompt } = {}) {
  if (!schema && !prompt) throw new LLMError("Provide a schema, a prompt, or both", "LLM_BAD_REQUEST", 400);
  const structured = schema ? toStructuredSchema(schema) : undefined;
  const wrapped = schema && structured.properties?.result && schema.type !== "object" && !schema.properties;
  const system = systemPrompt ? `${SYSTEM}\n\n${systemPrompt}` : SYSTEM;
  const warnings = [];
  const usage = [];

  // Pages longer than the per-request budget are cut, and the caller is told.
  const cap = Math.min(MAX_INPUT_CHARS, BATCH_CHARS * 4);
  for (const d of docs) {
    if ((d.markdown?.length ?? 0) > cap) warnings.push(`${d.url} was truncated to ${cap} characters for extraction`);
  }

  const batches = [];
  let current = [];
  let size = 0;
  for (const d of docs) {
    const len = Math.min(d.markdown?.length ?? 0, cap);
    if (current.length && size + len > BATCH_CHARS) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(d);
    size += len;
  }
  if (current.length) batches.push(current);

  const run = async batch => {
    const r = await callModel({
      system,
      userBlocks: [...batch.map(d => pageBlock(d, cap)), { type: "text", text: instruction({ prompt, schema }) }],
      schema: structured,
    });
    usage.push(r.usage);
    return r.data;
  };

  let data;
  if (batches.length === 1) {
    data = await run(batches[0]);
  } else {
    const partials = [];
    for (const b of batches) partials.push(await run(b));
    const merged = await callModel({
      system,
      userBlocks: [
        { type: "text", text: `<partial_results>\n${JSON.stringify(partials, null, 1)}\n</partial_results>` },
        {
          type: "text",
          text: `These are extraction results from different batches of pages. Merge them into one result: combine lists, remove duplicates, and prefer non-null values.${prompt ? ` Original instructions: ${prompt}` : ""}${schema ? "" : "\n\nReply with only the merged JSON object."}`,
        },
      ],
      schema: structured,
    });
    usage.push(merged.usage);
    data = merged.data;
  }
  return { data: wrapped ? data.result : data, warnings, usage };
}
