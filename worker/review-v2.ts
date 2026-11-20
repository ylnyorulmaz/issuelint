import {
  DOMAINS, TASK_TYPES, KINDS, SEVERITIES, ValidationError, parseAnalysis,
  type Task, type Analysis, type Finding,
} from "./schema.ts";

/** Explicit quality audit; a single missing checkbox is not an acceptable review. */
export const REVIEW_DIMENSIONS = [
  "contradictions", "scope", "behavior", "completion",
  "references", "dependencies", "clarity", "feasibility",
] as const;
export type ReviewDimension = typeof REVIEW_DIMENSIONS[number];
export type CheckAssessment = "clear" | "gap" | "not_applicable";
export type ReviewCheck = {
  dimension: ReviewDimension;
  assessment: CheckAssessment;
  severity: typeof SEVERITIES[number];
  kind: typeof KINDS[number];
  title: string;
  detail: string;
  evidence: string[];
  question: string;
};
export type ReviewContext = {
  domain: typeof DOMAINS[number];
  type: typeof TASK_TYPES[number];
  inferred: boolean;
};
export type ReviewedV2 = {
  analysis: Analysis;
  context: ReviewContext;
  checks: ReviewCheck[];
  rewriteCore: string;
  reviewCoverage: { checked: number; gaps: number; reported: number };
};

const CHECK = {
  type: "object",
  additionalProperties: false,
  properties: {
    dimension: { type: "string", enum: REVIEW_DIMENSIONS },
    assessment: { type: "string", enum: ["clear", "gap", "not_applicable"] },
    severity: { type: "string", enum: SEVERITIES },
    kind: { type: "string", enum: KINDS },
    title: { type: "string" },
    detail: { type: "string" },
    evidence: { type: "array", items: { type: "string" }, maxItems: 2 },
    question: { type: "string" },
  },
  required: ["dimension", "assessment", "severity", "kind", "title", "detail", "evidence", "question"],
} as const;

export const REVIEW_V2_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    detectedDomain: { type: "string", enum: DOMAINS },
    detectedType: { type: "string", enum: TASK_TYPES },
    summary: { type: "string" },
    checks: { type: "array", minItems: 8, maxItems: 8, items: CHECK },
    rewriteCore: { type: "string" },
  },
  required: ["detectedDomain", "detectedType", "summary", "checks", "rewriteCore"],
} as const;

function obj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function oneOf<const T extends readonly string[]>(v: unknown, arr: T): v is T[number] {
  return typeof v === "string" && arr.includes(v);
}
function text(v: unknown, max: number): string {
  if (typeof v !== "string" || v.length > max) throw new ValidationError("review", "Invalid review check text.");
  return v.trim();
}
function norm(v: string): string {
  return v.toLocaleLowerCase().normalize("NFKC").replace(/[\p{P}\p{S}\s]+/gu," ").trim();
}
function sourceHas(task: Task, quote: string): boolean {
  const source = [task.title,task.description,task.criteria,task.context].join(" ").replace(/\s+/g," ").toLocaleLowerCase();
  return source.includes(quote.replace(/\s+/g," ").toLocaleLowerCase().trim());
}

/** Heuristic hints are advisory only: infer domain from concrete text, not hidden UI defaults. */
export function contextHints(task: Task): {domain: typeof DOMAINS[number]; type: typeof TASK_TYPES[number]} {
  const s=[task.title,task.description,task.criteria,task.context].join(" ").toLocaleLowerCase();
  const software = /(dark.mode|dark theme|web app|website|mobile app|\bweb\b|\bmobile\b|\bapi\b|\bfrontend\b|\bbackend\b|\bui\b|arayüz|yazılım|uygulama|\bbug\b|\bdeploy\b)/iu;
  const marketing = /(campaign|marketing|newsletter|email marketing|brand awareness|kampanya|pazarlama|seo\b|conversion rate)/iu;
  const sales = /(\blead\b|outreach|\bcrm\b|prospect|pipeline|müşteri adayı|satış|quotation|teklif)/iu;
  const operations = /(procurement|warehouse|inventory|onboarding process|stok takibi|tedarik|operasyon|sevkiyat)/iu;
  const candidate = task.domain !== "Other" ? task.domain :
    software.test(s) ? "Software" : marketing.test(s) ? "Marketing" :
    sales.test(s) ? "Sales" : operations.test(s) ? "Operations" : "Other";
  const type = task.type !== "General" ? task.type :
    /(\bbug\b|broken|crash|hata|çalışmıyor)/iu.test(s) ? "Bug" :
    candidate === "Software" && /(add|implement|build|create|dark.mode|dark theme|ekle|geliştir)/iu.test(s) ? "Feature" :
    /(improve|optimize|iyileştir|geliştir)/iu.test(s) ? "Improvement" : "General";
  return {domain:candidate,type};
}

/** Remove generalized filler rather than treating it as a real finding. */
function hasSourceDependency(task: Task): boolean {
  return /\b(after|before|until|pending|approval|approved|blocked|depend|waiting|sign.off|requires)\b|onay|bekle|bağımlılık/iu.test(
    [task.title,task.description,task.criteria,task.context].join(" "));
}
function hasSourceReference(task: Task): boolean {
  return /\b(figma|link|url|document|doc|file|attachment|reference|specification|design file|template)\b|doküman|bağlantı|ek dosya|tasarım dosyası/iu.test(
    [task.title,task.description,task.criteria,task.context].join(" "));
}
function hasSourceFeasibilityConcern(task: Task): boolean {
  return /\b(impossible|cannot|can't|unsupported|unavailable|no access|not feasible|blocked by|doesn't support)\b|imkansız|mümkün değil|erişim yok|desteklemiyor/iu.test(
    [task.title,task.description,task.criteria,task.context].join(" "));
}
function isUnsupportedGap(c: ReviewCheck, task: Task): boolean {
  if(c.assessment !== "gap")return false;
  if(c.dimension==="dependencies" && !hasSourceDependency(task))return true;
  if(c.dimension==="references" && !hasSourceReference(task))return true;
  if(c.dimension==="feasibility" && !hasSourceFeasibilityConcern(task))return true;
  // A generic request to prove completion isn't always a blocker.
  if(c.dimension==="completion" && /what evidence will prove|how will you prove/i.test(c.question) && c.evidence.length===0)return true;
  return false;
}

function isGenericClarity(c: ReviewCheck): boolean {
  if (c.dimension !== "clarity" || c.evidence.length) return false;
  const content = norm(c.title+" "+c.question);
  return /(rewrite|rephrase|reword|clarify the task|explicitly state the deliverables|improve the wording|state the requirements)/i.test(content);
}

/** A priority gate: all 8 checks were inspected and the most important distinct gaps become findings. */
export function prioritizeChecks(checks: ReviewCheck[], task: Task): Finding[] {
  const rank: Record<ReviewCheck["severity"],number>={critical:0,important:1,suggestion:2};
  const candidates=checks.filter(c=>c.assessment==="gap" && !isGenericClarity(c) && !isUnsupportedGap(c,task))
    .sort((a,b)=>rank[a.severity]-rank[b.severity]||REVIEW_DIMENSIONS.indexOf(a.dimension)-REVIEW_DIMENSIONS.indexOf(b.dimension));
  const findings: Finding[]=[];
  const seen=new Set<string>();
  for(const c of candidates) {
    const key=norm(c.question||c.title);
    if(!key || seen.has(key))continue;
    seen.add(key);
    if(c.kind==="contradiction" && (c.evidence.length!==2 || c.evidence.some(q=>!sourceHas(task,q)))) {
      // Never present a contradiction lacking two verified quotes.
      continue;
    }
    findings.push({kind:c.kind,severity:c.severity,title:c.title,detail:c.detail,evidence:c.evidence,question:c.question});
    if(findings.length===5)break;
  }
  return findings;
}

export function parseReviewV2(value: unknown, task: Task): ReviewedV2 {
  if(!obj(value))throw new ValidationError("review","Expected review object.");
  if(!oneOf(value.detectedDomain,DOMAINS)||!oneOf(value.detectedType,TASK_TYPES))throw new ValidationError("context","Invalid review classification.");
  if(!Array.isArray(value.checks) || value.checks.length!==REVIEW_DIMENSIONS.length)throw new ValidationError("checks","Review must inspect all eight dimensions.");
  const checks:ReviewCheck[]=[];
  const seen=new Set<string>();
  for(const raw of value.checks){
    if(!obj(raw) || !oneOf(raw.dimension,REVIEW_DIMENSIONS) ||
      !oneOf(raw.assessment,["clear","gap","not_applicable"] as const) ||
      !oneOf(raw.severity,SEVERITIES) || !oneOf(raw.kind,KINDS))throw new ValidationError("checks","Malformed review check.");
    if(seen.has(raw.dimension))throw new ValidationError("checks","Duplicate review dimension.");
    seen.add(raw.dimension);
    if(!Array.isArray(raw.evidence) || raw.evidence.length>2 || raw.evidence.some(e=>typeof e!=="string"))throw new ValidationError("evidence","Invalid review evidence.");
    const evidence=raw.evidence.map(q=>{
      const original=text(q,260);
      // Models occasionally add typographic wrapper quotes. These are not part
      // of the cited source; strip wrappers, never fabricate missing excerpts.
      return original.replace(/^[\"“”'‘’]+|[\"“”'‘’]+$/gu,"").trim();
    }).filter(Boolean);
    if(evidence.some(q=>!sourceHas(task,q)))throw new ValidationError("evidence","Review evidence not found in source.");
    const c:ReviewCheck={
      dimension:raw.dimension, assessment:raw.assessment, severity:raw.severity,kind:raw.kind,
      title:text(raw.title,160),detail:text(raw.detail,800),
      evidence,question:text(raw.question,300),
    };
    if(c.assessment==="gap" && (!c.title || c.title.length<3 || !c.detail || !c.question))throw new ValidationError("checks","A gap must explain an actionable question.");
    if(c.assessment==="gap" && c.kind==="contradiction" && c.evidence.length!==2)throw new ValidationError("evidence","Contradiction must cite two source excerpts.");
    checks.push(c);
  }
  if(seen.size!==REVIEW_DIMENSIONS.length)throw new ValidationError("checks","Incomplete review audit.");
  const hints=contextHints(task);
  const domain=task.domain!=="Other"?task.domain:value.detectedDomain==="Other"?hints.domain:value.detectedDomain;
  const type=task.type!=="General"?task.type:value.detectedType==="General"?hints.type:value.detectedType;
  const findings=prioritizeChecks(checks,task);
  const status=findings.some(f=>f.kind==="contradiction"&&f.severity==="critical")?"blocked":
    findings.some(f=>f.severity==="important"||f.severity==="critical")?"needs_clarification":"ready";
  const summary=text(value.summary,700);
  const rewriteCore=text(value.rewriteCore,6500);
  const analysis=parseAnalysis({status,summary,findings,suggestedRewrite:""},task);
  return {analysis,checks,context:{domain,type,inferred:task.domain==="Other"||task.type==="General"},
    rewriteCore,reviewCoverage:{checked:8,gaps:checks.filter(c=>c.assessment==="gap").length,reported:findings.length}};
}
