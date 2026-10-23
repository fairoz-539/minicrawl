// AI extraction with Claude: the `json` scrape format and /v1/extract.
// Firecrawl does this with OpenAI-style generateObject (transformers/llmExtract.ts);
// here it is Claude structured outputs (output_config.format json_schema).
//
// Credentials: ANTHROPIC_API_KEY (or any source the Anthropic SDK resolves).
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.LLM_MODEL ?? "claude-opus-5-5";
const EFFORT = process.env.LLM_EFFORT ?? "medium";
const MAX_INPUT_CHARS = Number(process.env.LLM_MAX_INPUT_CHARS ?? 1_500_000); // ~375k tokens
const BATCH_CHARS = Number(process.env.LLM_BATCH_CHARS ?? 400_000);
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
    max_tokens: 64000,
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
    const r = await callClaude({
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
    const merged = await callClaude({
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
