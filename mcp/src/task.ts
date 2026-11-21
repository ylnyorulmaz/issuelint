/** Input schemas and the mapping onto the Worker task contract (worker/schema.ts `parseTask`). */
import { z } from "zod";

export const TASK_TYPES = ["General", "Bug", "Feature", "Improvement", "Request"] as const;
/** The Worker accepts all five; Software is the default for coding agents. */
export const DOMAINS = ["Software", "Marketing", "Sales", "Operations", "Other"] as const;

export const LIMITS = {
  title: 180,
  description: 6_500,
  criteria: 1_200,
  context: 1_200,
  scope: 1_000,
  outcome: 1_000,
  references: 1_000,
  total: 8_000,
} as const;

const optionalText = (max: number, what: string) =>
  z.string().trim().max(max).optional().describe(`${what} (optional, max ${max.toLocaleString("en-US")} characters).`);

export const lintTaskShape = {
  title: z.string().trim().min(1).max(LIMITS.title).describe("Short task or ticket title (1–180 characters)."),
  description: z.string().trim().min(1).max(LIMITS.description)
    .describe("The task description exactly as written by the user (1–6,500 characters). Do not rewrite or embellish it."),
  type: z.enum(TASK_TYPES).default("General").describe("Task type. Default: General."),
  domain: z.enum(DOMAINS).default("Software").describe("Business domain. Default: Software."),
  criteria: optionalText(LIMITS.criteria, "Acceptance criteria / definition of done"),
  context: optionalText(LIMITS.context, "Background context"),
  scope: optionalText(LIMITS.scope, "What is in and out of scope"),
  outcome: optionalText(LIMITS.outcome, "Expected outcome"),
  references: optionalText(LIMITS.references, "Links, specs or related tickets"),
};

export const lintMarkdownShape = {
  markdown: z.string().trim().min(1).max(LIMITS.description)
    .describe("Raw Markdown of the task, GitHub issue body, PRD excerpt or copied ticket (1–6,500 characters, the IssueLint description limit). Pass it verbatim."),
  page_title: z.string().trim().max(500).optional()
    .describe("Title of the source page or ticket. If omitted, the first line of the Markdown is used."),
  source_url: z.string().trim().max(2_048).optional()
    .describe("Where the text came from. Returned in the result metadata only; it is not sent to IssueLint."),
  domain: z.enum(DOMAINS).optional().describe("Business domain. Default: Software."),
};

type Shape<T extends Record<string, z.ZodType>> = { [K in keyof T]: z.output<T[K]> };
export type LintTaskInput = Shape<typeof lintTaskShape>;
export type LintMarkdownInput = Shape<typeof lintMarkdownShape>;

export interface WorkerTask {
  title: string;
  description: string;
  type: (typeof TASK_TYPES)[number];
  domain: (typeof DOMAINS)[number];
  criteria?: string;
  context?: string;
  scope?: string;
  outcome?: string;
  references?: string;
}

export class TaskInputError extends Error {}

function totalLength(task: WorkerTask): number {
  return task.title.length + task.description.length + (task.criteria?.length ?? 0) + (task.context?.length ?? 0) +
    (task.scope?.length ?? 0) + (task.outcome?.length ?? 0) + (task.references?.length ?? 0);
}

function checkTotal(task: WorkerTask): WorkerTask {
  const total = totalLength(task);
  if (total > LIMITS.total) {
    throw new TaskInputError(
      `All text fields together are ${total.toLocaleString("en-US")} characters; IssueLint accepts at most ${LIMITS.total.toLocaleString("en-US")}. ` +
      "Trim optional fields or the description and try again.");
  }
  return task;
}

export function taskFromInput(input: LintTaskInput): WorkerTask {
  const task: WorkerTask = { title: input.title, description: input.description, type: input.type, domain: input.domain };
  // Only send optional fields that carry text: an empty field is the same as an absent one for the Worker.
  for (const key of ["criteria", "context", "scope", "outcome", "references"] as const) {
    const value = input[key];
    if (value) task[key] = value;
  }
  return checkTotal(task);
}

/** Same mapping as the IssueLint Clipper extension: page title (or first Markdown line) + verbatim Markdown. */
export function taskFromMarkdown(input: LintMarkdownInput): WorkerTask {
  const description = input.markdown.trim();
  const fromPage = (input.page_title ?? "").replace(/\s+/g, " ").trim();
  const firstLine = description.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const title = (fromPage || firstLine.replace(/^#{1,6}\s+/, "").slice(0, 120)).slice(0, LIMITS.title).trim();
  if (!title) throw new TaskInputError("Could not derive a title. Pass page_title.");
  return checkTotal({ title, description, type: "General", domain: input.domain ?? "Software" });
}
