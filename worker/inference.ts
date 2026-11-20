import { ANALYSIS_JSON_SCHEMA, parseAnalysis, type Analysis, type Task } from "./schema.ts";
import { SYSTEM_PROMPT, taskMessage } from "./prompt.ts";

/** Prefer deterministic structured review over long invisible reasoning. */
export const DEFAULT_MODEL = "@cf/openai/gpt-oss-20b";
export const ALLOWED_MODELS = [DEFAULT_MODEL, "@cf/google/gemma-4-26b-a4b-it"] as const;

export interface AiRunner {
  run(model: string, input: {
    messages: { role: "system" | "user"; content: string }[];
    response_format: { type: "json_schema"; json_schema: typeof ANALYSIS_JSON_SCHEMA };
    temperature: number;
    max_tokens: number;
    reasoning_effort: "low";
    stream: false;
  }): Promise<unknown>;
}

export class InferenceError extends Error {
  readonly kind: "upstream" | "invalid_response" | "truncated";
  constructor(kind: "upstream" | "invalid_response" | "truncated") {
    super(kind);
    this.kind = kind;
    this.name = "InferenceError";
  }
}

export function selectModel(configured: string | undefined): typeof ALLOWED_MODELS[number] {
  return configured && ALLOWED_MODELS.includes(configured as typeof ALLOWED_MODELS[number])
    ? configured as typeof ALLOWED_MODELS[number]
    : DEFAULT_MODEL;
}

function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Handles both native completion variants without accepting reasoning-only responses. */
export function extractJsonResponse(raw: unknown): unknown {
  if (!record(raw)) throw new InferenceError("invalid_response");
  let candidate: unknown = raw;
  if ("response" in raw) candidate = raw.response;
  else if (Array.isArray(raw.choices)) {
    const choice = raw.choices[0];
    if (!record(choice)) throw new InferenceError("invalid_response");
    if (choice.finish_reason === "length") throw new InferenceError("truncated");
    const message = choice.message;
    candidate = record(message) ? message.content : null;
  }
  if (typeof candidate === "string") {
    if (candidate.length > 32_000) throw new InferenceError("invalid_response");
    try { return JSON.parse(candidate); }
    catch { throw new InferenceError("invalid_response"); }
  }
  if (record(candidate)) return candidate;
  throw new InferenceError("invalid_response");
}

export async function runAnalysis(task: Task, ai: AiRunner, model = DEFAULT_MODEL): Promise<Analysis> {
  let raw: unknown;
  try {
    raw = await ai.run(selectModel(model), {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: taskMessage(task) },
      ],
      response_format: { type: "json_schema", json_schema: ANALYSIS_JSON_SCHEMA },
      // For gpt-oss-20b, low reasoning produces final JSON without using the entire token budget.
      reasoning_effort: "low",
      max_tokens: 1600,
      temperature: 0.1,
      stream: false,
    });
  } catch {
    // No exception messages: provider errors may include request content.
    throw new InferenceError("upstream");
  }
  try {
    const output = extractJsonResponse(raw);
    // Some models return valid findings but an empty rewrite. Preserve the
    // user's source text rather than invent details or fail the whole review.
    const normalized = output !== null && typeof output === "object" && !Array.isArray(output)
      ? { ...output as Record<string, unknown> }
      : output;
    if (normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)) {
      const item = normalized as Record<string, unknown>;
      if (typeof item.suggestedRewrite !== "string" || item.suggestedRewrite.trim().length < 5) {
        item.suggestedRewrite = [
          task.title,
          task.description,
          task.criteria ? "Completion criteria:\n" + task.criteria : "",
          task.context ? "Additional context:\n" + task.context : "",
        ].filter(Boolean).join("\n\n");
      }
    }
    return parseAnalysis(normalized, task);
  } catch (cause) {
    if (cause instanceof InferenceError && cause.kind === "truncated") throw cause;
    throw new InferenceError("invalid_response");
  }
}
