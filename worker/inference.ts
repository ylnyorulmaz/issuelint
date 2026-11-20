import { ANALYSIS_JSON_SCHEMA, parseAnalysis, type Analysis, type Task } from "./schema.ts";
import { SYSTEM_PROMPT, taskMessage } from "./prompt.ts";

export const DEFAULT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const ALLOWED_MODELS = [DEFAULT_MODEL, "@cf/openai/gpt-oss-20b"] as const;

/** Minimal runtime contract for the native Workers AI binding; no SDK required. */
export interface AiRunner {
  run(model: string, input: {
    messages: { role: "system" | "user"; content: string }[];
    response_format: { type: "json_schema"; json_schema: typeof ANALYSIS_JSON_SCHEMA };
    temperature: number;
    max_completion_tokens: number;
    stream: false;
    store: false;
  }): Promise<unknown>;
}

export class InferenceError extends Error {
  constructor(public readonly kind: "upstream" | "invalid_response") {
    super(kind);
    this.name = "InferenceError";
  }
}

export function selectModel(configured: string | undefined): typeof ALLOWED_MODELS[number] {
  if (!configured || !ALLOWED_MODELS.includes(configured as typeof ALLOWED_MODELS[number])) return DEFAULT_MODEL;
  return configured as typeof ALLOWED_MODELS[number];
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown> : null;
}

/** Native Workers AI models may use response or ChatCompletion choices. */
export function extractJsonResponse(raw: unknown): unknown {
  const result = asRecord(raw);
  if (!result) throw new InferenceError("invalid_response");

  let candidate: unknown = raw;
  if ("response" in result) candidate = result.response;
  else if (Array.isArray(result.choices)) {
    const choice = asRecord(result.choices[0]);
    const message = asRecord(choice?.message);
    if (choice?.finish_reason === "length") throw new InferenceError("invalid_response");
    candidate = message?.content;
  }

  if (typeof candidate === "string") {
    if (candidate.length > 32_000) throw new InferenceError("invalid_response");
    try { return JSON.parse(candidate); }
    catch { throw new InferenceError("invalid_response"); }
  }
  if (asRecord(candidate)) return candidate;
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
      temperature: 0.1,
      max_completion_tokens: 1500,
      stream: false,
      store: false,
    });
  } catch {
    throw new InferenceError("upstream");
  }

  try { return parseAnalysis(extractJsonResponse(raw), task); }
  catch { throw new InferenceError("invalid_response"); }
}
