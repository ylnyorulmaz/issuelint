/** Validated public API contract. No dependencies and no platform-specific logic. */
export const TASK_TYPES = ["General", "Bug", "Feature", "Improvement", "Request"] as const;
export const DOMAINS = ["Software", "Marketing", "Sales", "Operations", "Other"] as const;
export const KINDS = ["missing", "ambiguity", "contradiction", "suggestion"] as const;
export const SEVERITIES = ["critical", "important", "suggestion"] as const;
export const STATUSES = ["ready", "needs_clarification", "blocked"] as const;

export type Task = {
  title: string;
  description: string;
  type: typeof TASK_TYPES[number];
  domain: typeof DOMAINS[number];
  criteria: string;
  context: string;
};

export type Finding = {
  kind: typeof KINDS[number];
  severity: typeof SEVERITIES[number];
  title: string;
  detail: string;
  evidence: string[];
  question: string;
};

export type Analysis = {
  status: typeof STATUSES[number];
  summary: string;
  findings: Finding[];
  suggestedRewrite: string;
};

export class ValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
    this.name = "ValidationError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== "string") throw new ValidationError(name, `${name} must be text.`);
  const s = value.trim();
  if (s.length < min || s.length > max) {
    throw new ValidationError(name, `${name} must contain between ${min} and ${max} characters.`);
  }
  return s;
}

function enumValue<const T extends readonly string[]>(value: unknown, name: string, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ValidationError(name, `${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T[number];
}

export function parseTask(value: unknown): Task {
  if (!record(value)) throw new ValidationError("body", "Provide a JSON object.");
  const task = {
    title: field(value.title, "title", 1, 180),
    description: field(value.description, "description", 1, 6500),
    type: enumValue(value.type, "type", TASK_TYPES),
    domain: enumValue(value.domain, "domain", DOMAINS),
    criteria: field(value.criteria ?? "", "criteria", 0, 1200),
    context: field(value.context ?? "", "context", 0, 1200),
  };
  const length = task.title.length + task.description.length + task.criteria.length + task.context.length;
  if (length > 8000) throw new ValidationError("body", "Total text cannot exceed 8,000 characters.");
  return task;
}

export const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: STATUSES },
    summary: { type: "string" },
    findings: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: KINDS },
          severity: { type: "string", enum: SEVERITIES },
          title: { type: "string" },
          detail: { type: "string" },
          evidence: { type: "array", items: { type: "string" }, maxItems: 2 },
          question: { type: "string" },
        },
        required: ["kind", "severity", "title", "detail", "evidence", "question"],
      },
    },
    suggestedRewrite: { type: "string" },
  },
  required: ["status", "summary", "findings", "suggestedRewrite"],
} as const;

function outputString(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) {
    throw new ValidationError(name, `Invalid AI output field: ${name}.`);
  }
  return value.trim();
}
function containsLiteral(task: Task, fragment: string): boolean {
  const source = [task.title, task.description, task.criteria, task.context].join("\n")
    .replace(/\s+/g, " ").toLocaleLowerCase();
  return source.includes(fragment.replace(/\s+/g, " ").trim().toLocaleLowerCase());
}

export function parseAnalysis(value: unknown, task: Task): Analysis {
  if (!record(value)) throw new ValidationError("model", "AI output is not a JSON object.");
  const status = enumValue(value.status, "status", STATUSES);
  const summary = outputString(value.summary, "summary", 5, 700);
  const suggestedRewrite = outputString(value.suggestedRewrite, "suggestedRewrite", 5, 6500);
  if (!Array.isArray(value.findings) || value.findings.length > 5) {
    throw new ValidationError("findings", "AI output has too many findings or an invalid list.");
  }
  const findings = value.findings.map((raw: unknown, i: number): Finding => {
    if (!record(raw)) throw new ValidationError("findings", "Invalid finding object.");
    const kind = enumValue(raw.kind, `findings[${i}].kind`, KINDS);
    const severity = enumValue(raw.severity, `findings[${i}].severity`, SEVERITIES);
    const title = outputString(raw.title, "finding.title", 3, 160);
    const detail = outputString(raw.detail, "finding.detail", 5, 800);
    if (!Array.isArray(raw.evidence) || raw.evidence.length > 2) {
      throw new ValidationError("evidence", "Invalid evidence quotes.");
    }
    const evidence = raw.evidence.map((part: unknown) => outputString(part, "evidence", 2, 260));
    if (evidence.some((quote: string) => !containsLiteral(task, quote))) {
      throw new ValidationError("evidence", "AI cited words not present in the task.");
    }
    if (kind === "contradiction" && evidence.length !== 2) {
      throw new ValidationError("evidence", "Contradictions require two source quotes.");
    }
    const question = outputString(raw.question, "finding.question", 0, 300);
    return { kind, severity, title, detail, evidence, question };
  });
  if (status === "ready" && findings.some((f) => f.severity === "critical")) {
    throw new ValidationError("status", "AI output status conflicts with critical findings.");
  }
  return { status, summary, findings, suggestedRewrite };
}
