import {
  DOMAINS, TASK_TYPES, KINDS, SEVERITIES, ValidationError, parseAnalysis, taskSource,
  type Task, type Analysis, type Finding,
} from "./schema.ts";

/** Review Engine 2.4: eight execution checks plus three task-quality dimensions. */
export const REVIEW_DIMENSIONS = [
  "contradictions", "actionability", "scope", "granularity",
  "behavior", "completion", "outcome", "references",
  "dependencies", "clarity", "feasibility",
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
  findingDimensions: ReviewDimension[];
  contradictionGuardTriggered: boolean;
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
    checks: { type: "array", minItems: REVIEW_DIMENSIONS.length, maxItems: REVIEW_DIMENSIONS.length, items: CHECK },
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
  const source = taskSource(task).replace(/\s+/g," ").toLocaleLowerCase();
  return source.includes(quote.replace(/\s+/g," ").toLocaleLowerCase().trim());
}

/** Heuristic hints are advisory only: infer domain from concrete text, not hidden UI defaults. */
export function contextHints(task: Task): {domain: typeof DOMAINS[number]; type: typeof TASK_TYPES[number]} {
  const s=taskSource(task).toLocaleLowerCase();
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

/** Conservative contradiction guard for explicit, source-verifiable conflicts.
 * This supplements (never replaces) the model's cross-domain audit.
 */
export function highConfidenceContradictions(task: Task): Finding[] {
  const sourceChunks=[task.title,task.description,task.criteria,task.context,task.scope??"",task.outcome??"",task.references??""]
    .flatMap(v=>v.split(/(?<=[.!?])\s+|\n+/u)).map(v=>v.trim()).filter(Boolean);
  const result:Finding[]=[];
  const urgency=sourceChunks.find(v=>
    /\b(today|bugün)\b/iu.test(v) &&
    /\b(contact|send|message|outreach|lead|everyone|all|reach|ulaş|gönder|mesaj|herkes)\b/iu.test(v));
  const gate=sourceChunks.find(v=>
    /\b(tomorrow|yarın)\b/iu.test(v) &&
    /\b(do not|don't|must not|cannot|can't|before|until|approval|approved|onay|bekle|gönderme)\b/iu.test(v));
  if(urgency && gate && urgency!==gate) {
    result.push({
      kind:"contradiction",severity:"critical",
      title:"Deadline conflicts with prerequisite",
      detail:"The task requires outreach today but also prohibits sending until an approval scheduled tomorrow.",
      evidence:[urgency.slice(0,260),gate.slice(0,260)],
      question:"Should the outreach deadline move until after approval, or is the approval date changing?",
    });
  }
  const all=sourceChunks.find(v=>/\b(all|every|everyone)\b/iu.test(v) && /\b(lead|prospect|contact)\b/iu.test(v));
  const only=sourceChunks.find(v=>/\bonly\b.{0,30}\b(qualified|eligible|selected)\b.{0,30}\b(leads?|prospects?|contacts?)\b/iu.test(v));
  if(all && only && all!==only) {
    result.push({
      kind:"contradiction",severity:"critical",
      title:"Audience instructions conflict",
      detail:"One instruction includes every lead; another limits outreach to qualified leads only.",
      evidence:[all.slice(0,260),only.slice(0,260)],
      question:"Should outreach target all leads or qualified leads only?",
    });
  }
  return result;
}

/** Remove generalized filler rather than treating it as a real finding. */
function hasSourceDependency(task: Task): boolean {
  return /\b(after|before|until|pending|approval|approved|blocked|depend|waiting|sign.off|requires|no repository access|no repo access|no test environment|no staging access|missing access|access unavailable)\b|onay|bekle|bağımlılık|erişim yok/iu.test(
    taskSource(task));
}
function hasSourceReference(task: Task): boolean {
  if (task.references?.trim()) return true;
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

/** Prioritize execution-blocking decisions for each domain; chronology/wording last. */
export function dimensionPriority(task:Task): readonly ReviewDimension[] {
  const hint=contextHints(task);
  const domain=task.domain==="Other"?hint.domain:task.domain;
  switch(domain) {
    case "Software":
      return ["contradictions","actionability","scope","granularity","behavior","completion","references","dependencies","feasibility","outcome","clarity"];
    case "Sales":
      return ["contradictions","actionability","scope","granularity","behavior","dependencies","completion","outcome","references","feasibility","clarity"];
    case "Marketing":
      return ["contradictions","actionability","scope","granularity","outcome","behavior","completion","references","dependencies","feasibility","clarity"];
    case "Operations":
      return ["contradictions","actionability","dependencies","scope","granularity","completion","behavior","references","outcome","feasibility","clarity"];
    default:
      return ["contradictions","actionability","scope","granularity","behavior","completion","outcome","references","dependencies","feasibility","clarity"];
  }
}

/** Evidence and decision-oriented overlap. Two different source conflicts may
 * share a sentence; shared evidence alone is never sufficient to merge them.
 */
function evidenceOverlap(a:Finding,b:Finding):number {
  const quotes=(xs:string[])=>xs.map(norm).filter(Boolean);
  const left=quotes(a.evidence),right=quotes(b.evidence);
  return left.filter(q=>right.some(other=>q===other || (Math.min(q.length,other.length)>18 && (q.includes(other)||other.includes(q))))).length;
}
const STOP_WORDS=new Set([
  "which","should","would","could","these","those","there","their","about","being",
  "before","after","with","from","into","what","when","where","need","needs","must",
  "only","task","work","issue","clear","missing","details","requirements","requirement",
  "the","and","for","are","can","you","this","that","who","have","will",
]);
function meaningfulWords(value:string):Set<string>{
  return new Set(norm(value).split(" ").filter(w=>w.length>=4 && !STOP_WORDS.has(w)));
}
function similarity(a:string,b:string):number {
  const left=meaningfulWords(a),right=meaningfulWords(b);
  if(!left.size||!right.size)return 0;
  let overlap=0;
  for(const w of left)if(right.has(w))overlap++;
  return overlap/Math.min(left.size,right.size);
}
/** Domain-aware decision categories. No category alone proves equivalence. */
function decisionFamily(f:Finding):string {
  const focus=norm(f.title+" "+f.question);
  const patterns:readonly [string,RegExp][]=[
    ["screen-scope",/\b(screens?|pages?|components?|views?|coverage)\b/iu],
    ["theme-behavior",/\b(toggle|switch|persist|persistence|theme|preferences?|sessions?|system setting)\b/iu],
    ["design-reference",/\b(figma|design link|file url|attachment|reference link|file identifier)\b/iu],
    ["delivery-time",/\b(deadline|timing|approval|approved|before|after|prerequisite|today|tomorrow|date changing|onay|bugün|yarın)\b/iu],
    ["audience",/\b(audience|qualified|leads?|prospects?|recipients?|everyone|target group|which contacts)\b/iu],
    ["completion",/\b(acceptance|completion|verification|tests?|done criteria)\b/iu],
    ["granularity",/\b(split|epic|work packages|independent deliverables|smaller tasks)\b/iu],
  ];
  for(const [family,pattern] of patterns)if(pattern.test(focus))return family;
  return "";
}
function sameRootIssue(candidate:Finding,selected:Finding):boolean {
  const overlap=evidenceOverlap(candidate,selected);
  const first=decisionFamily(candidate),second=decisionFamily(selected);
  const sameFamily=!!first && first===second;
  const questionSimilarity=similarity(candidate.question,selected.question);
  const headingSimilarity=similarity(candidate.title,selected.title);
  // A matching two-excerpt conflict is the same conflict even if paraphrased.
  if(candidate.kind==="contradiction"&&selected.kind==="contradiction"&&overlap>=2) {
    // The SAME two excerpts can support TWO independent decisions (e.g. who vs when).
    return !(first && second && first !== second);
  }
  // Rephrased questions can indicate a repeated decision without matching titles.
  if(questionSimilarity>=0.78 && (sameFamily || overlap>0))return true;
  // A supporting "pending approval" gap is already covered by the cited timing
  // conflict; an independent requirement with different evidence is retained.
  if(sameFamily && overlap>0)return true;
  if(sameFamily && headingSimilarity>=0.85 && questionSimilarity>=0.5)return true;
  return false;
}

/** Return source-verified, nonoverlapping decisions rather than every rubric gap.
 * Blocked tasks surface two distinct verified blockers and at most one other
 * independent issue. No new model call or unverifiable semantic assertion.
 */
export function prioritizeChecks(checks: ReviewCheck[], task: Task): Finding[] {
  const rank: Record<ReviewCheck["severity"],number>={critical:0,important:1,suggestion:2};
  const order=dimensionPriority(task);
  const candidates=checks.filter(c=>c.assessment==="gap" && !isGenericClarity(c) && !isUnsupportedGap(c,task))
    .sort((a,b)=>rank[a.severity]-rank[b.severity]||order.indexOf(a.dimension)-order.indexOf(b.dimension));
  const selected:Finding[]=[];
  const add=(finding:Finding)=>{
    if(selected.some(existing=>sameRootIssue(finding,existing)))return false;
    selected.push(finding);
    return true;
  };
  // Grounded contradictions have precedence over model paraphrases.
  for(const f of highConfidenceContradictions(task))add(f);
  const blocked=selected.some(f=>f.kind==="contradiction"&&f.severity==="critical") ||
    candidates.some(c=>c.kind==="contradiction"&&c.severity==="critical"&&c.evidence.length===2);
  for(const c of candidates){
    if(c.kind==="contradiction" && (c.evidence.length!==2 || c.evidence.some(q=>!sourceHas(task,q))))continue;
    add({kind:c.kind,severity:c.severity,title:c.title,detail:c.detail,evidence:c.evidence,question:c.question});
  }
  const ordered=selected.sort((a,b)=>rank[a.severity]-rank[b.severity]);
  if(!blocked)return ordered.slice(0,5);
  const blockers=ordered.filter(f=>f.kind==="contradiction"&&f.severity==="critical").slice(0,2);
  const supporting=ordered.find(f=>!(f.kind==="contradiction"&&f.severity==="critical") &&
    !blockers.some(b=>sameRootIssue(f,b)));
  return [...blockers,...(supporting?[supporting]:[])].slice(0,3);
}

/** Derive the user-visible verdict from the FINAL selected findings, not the model's stale summary. */
export function deriveReviewSummary(status: Analysis["status"], findings: Finding[], task: Task): string {
  const source = (task.title + " " + task.description).toLocaleLowerCase();
  const turkish = /[çğıöşüı]|\b(görev|kullanıcı|ekran|yapılacak|için|olmalı|gerekiyor)\b/iu.test(source);
  const heads = findings.slice(0,2).map(f=>f.title.trim().replace(/[.!?]+$/g,"")).filter(Boolean).join("; ").slice(0,350);
  if(status==="blocked") return turkish
    ? "Görev çelişen talimatlar nedeniyle bloke: " + heads + ". Devam etmeden önce çelişkileri giderin."
    : "Conflicting requirements block this task: " + heads + ". Resolve them before execution.";
  if(status==="needs_clarification") return turkish
    ? "Görevin uygulanabilmesi için şu konular netleştirilmeli: " + heads + ". Bulgulardaki soruları yanıtlayın."
    : "Execution requires clarification on: " + heads + ". Resolve the questions in the findings.";
  if(findings.length) return turkish
    ? "Engelleyici eksik bulunmadı; " + findings.length + " iyileştirme önerisi var. Başlamadan önce gözden geçirin."
    : "No blocking gaps found; " + findings.length + " optional improvement(s) remain for review.";
  return turkish
    ? "11 kalite boyutunda engelleyici eksik bulunmadı. Uygulamadan önce ayrıntıları doğrulayın."
    : "No blocking gaps found across 11 quality dimensions. Verify the details before execution.";
}

export function parseReviewV2(value: unknown, task: Task): ReviewedV2 {
  if(!obj(value))throw new ValidationError("review","Expected review object.");
  if(!oneOf(value.detectedDomain,DOMAINS)||!oneOf(value.detectedType,TASK_TYPES))throw new ValidationError("context","Invalid review classification.");
  if(!Array.isArray(value.checks) || value.checks.length!==REVIEW_DIMENSIONS.length)throw new ValidationError("checks","Review must inspect every quality dimension.");
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
      return original.replace(/^["“”'‘’]+|["“”'‘’]+$/gu,"").trim();
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
  const contradictionGuardTriggered=checks.find(c=>c.dimension==="contradictions")?.assessment!=="gap" &&
    findings.some(f=>f.kind==="contradiction"&&f.severity==="critical");
  if(findings.some(f=>f.kind==="contradiction"&&f.severity==="critical")) {
    const conflict=checks.find(c=>c.dimension==="contradictions");
    const first=findings.find(f=>f.kind==="contradiction");
    if(conflict && first && conflict.assessment!=="gap"){
      conflict.assessment="gap"; conflict.severity="critical"; conflict.kind="contradiction";
      conflict.title=first.title;conflict.detail=first.detail;
      conflict.evidence=first.evidence;conflict.question=first.question;
    }
  }
  const status=findings.some(f=>f.kind==="contradiction"&&f.severity==="critical")?"blocked":
    findings.some(f=>f.severity==="important"||f.severity==="critical")?"needs_clarification":"ready";
  // Model summary is validated but never trusted as the final verdict narrative.
  // A second-pass gate can add gaps after the model wrote its original summary.
  text(value.summary,700);
  const summary=deriveReviewSummary(status,findings,task);
  const rewriteCore=text(value.rewriteCore,6500);
  const analysis=parseAnalysis({status,summary,findings,suggestedRewrite:""},task);
  const findingDimensions=findings.map(f=>{
    const corresponding=checks.find(c=>c.assessment==="gap" &&
      norm(c.title)===norm(f.title) && norm(c.question)===norm(f.question));
    return corresponding?.dimension ?? "contradictions";
  });
  return {analysis,checks,context:{domain,type,inferred:task.domain==="Other"||task.type==="General"},
    rewriteCore,contradictionGuardTriggered,findingDimensions,
    reviewCoverage:{checked:REVIEW_DIMENSIONS.length,gaps:checks.filter(c=>c.assessment==="gap").length,reported:findings.length}};
}
