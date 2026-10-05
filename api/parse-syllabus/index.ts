import type { IncomingMessage, ServerResponse } from "node:http";
import Groq, { APIError } from "groq-sdk";

export const config = {
  runtime: "nodejs",
  maxDuration: 60,
};

const MAX_SYLLABUS_CHARS = 80_000;
const GROQ_SAFE_INPUT_TOKENS = 7_400;
const CHARS_PER_TOKEN_ESTIMATE = 3.8;
const SYLLABUS_INTRO_CHARS = 1_600;
const GRADING_WINDOW_CONTEXT = 480;
const MIN_WINDOW_SCORE = 4;
const BUSY_ERROR = "The AI service is temporarily busy. Please try again in a moment.";
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const GROQ_MODEL = "openai/gpt-oss-20b";

const EXTRACTION_PROMPT_PREFIX = `Extract grading from this syllabus. Return ONLY valid JSON.

JSON shape:
{"code":"CHEM 1210","name":"course name","professor":"Prof. Name","credits":3,"dropLowest":false,"penaltyNote":null,"components":[{"id":"hw","name":"Homework","weight":10,"total":100,"category":"Homework"},{"id":"q1","name":"Quiz 1","weight":1.25,"total":100,"category":"Quizzes"},{"id":"unit1","name":"Unit 1","weight":20,"total":100,"category":"Units","composition":[{"name":"Attendance","role":"attendance","notes":"Attendance is part of this unit and can change the relative weight of the unit exam."},{"name":"Unit 1 Exam","role":"exam"}]}],"gradeScale":[{"label":"A","min":93.0},{"label":"A-","min":90.0},{"label":"B+","min":87.0},{"label":"B","min":83.0},{"label":"B-","min":80.0},{"label":"C+","min":77.0},{"label":"C","min":73.0},{"label":"D","min":60.0},{"label":"F","min":0}],"gpaMax":null,"gradingPolicies":[{"type":"drop_lowest","appliesTo":"quizzes","quantity":2,"description":"Lowest 2 quiz scores are dropped.","calculationEffect":"exclude_lowest","appliesToCalculation":true,"informationalOnly":false},{"type":"keep_best_n","appliesTo":"quizzes","quantity":4,"description":"Sample grade calculation says 4 Highest Quizzes.","calculationEffect":"keep_highest_n","appliesToCalculation":false,"informationalOnly":false,"requiresVerification":true},{"type":"grading_conflict","appliesTo":"quizzes","description":"The syllabus states that the lowest 2 of 8 quizzes are dropped, but the sample grade calculation says 4 Highest Quizzes.","severity":"warning","requiresVerification":true,"appliesToCalculation":false,"informationalOnly":true,"sourceStatements":["lowest 2 quizzes are dropped","4 Highest Quizzes"]},{"type":"exam_replacement","appliesTo":"unit_exams","relatedComponents":["final"],"description":"If the final exam score is higher than any unit exam, the lower unit exam score is replaced by the final exam score.","calculationEffect":"replace_lower_unit_exam_with_final_if_higher","appliesToCalculation":true,"informationalOnly":false},{"type":"attendance_allowance","appliesTo":"attendance","description":"All absences are automatically excused; an absence does not simply drop an attendance score and can increase the unit exam weight. Recovery is possible via the stated professor-approved process within one week.","calculationEffect":"excused_absence_reweights_unit_exam","appliesToCalculation":true,"informationalOnly":false}]}

HARD RULES:
- The syllabus text is the only source of truth. Never invent a rule, cutoff, weight, count, or GPA.
- If the syllabus states an explicit numerical percentage-to-letter-grade scale, copy the EXACT numeric minimums. Do not replace them with any default/Utah/generic scale. Include only letters the syllabus lists. Do not invent A+ or C- if they are absent. Preserve decimals such as 93.0.
- If the syllabus does NOT publish an explicit percentage-to-letter table (for example it only mentions a school grading policy, a target GPA, or curve language), gradeScale MUST be null. Do NOT invent cutoffs such as A=94 or copy any fallback scale.
- Return credits as null unless the syllabus explicitly states credit hours (for example "3 credits", "3 cr", "Credit Hours: 3", "Three (3) hours"). Do not invent credits. Never use 0 as a placeholder.
- Weights of normal graded components must sum to 100. Extra credit without an explicit percentage is NOT a weighted component.
- Expand repeating assessments into individual rows that share a category (3 quizzes → Quiz 1..Quiz 3; 8 quizzes → Quiz 1..Quiz 8). Never emit a single "Quizzes — W%" (or Homework/Labs/etc.) row when the syllabus states how many scored items exist.
- If N items are given and the lowest K are dropped, still emit all N rows. If the remaining R items count X% each, the category total is W = R × X (e.g. 8 quizzes, drop 1, remaining 7 count 3% each → W = 21). Store each of the N rows at weight W/N, NOT X. Weights of the N rows must SUM to W. The drop-lowest policy (quantity K) redistributes W across the kept items so each kept item is effectively X%.
- Put the same category name on each expanded row. Set each row's total to the syllabus point value for one item (e.g. 50) when stated.
- Only keep a single aggregate category row when the syllabus gives a category percentage and does NOT state an individual item count (no "N quizzes", "N labs", etc.).
- If a category such as Unit 1/2/3 includes attendance PLUS an exam, keep ONE weighted component for the unit and describe the internal mechanism in composition[]. Do not fake separate percentage weights unless the syllabus states them. Do not model excused absence as drop_lowest attendance.
- dropLowest must be true ONLY for a course-wide lowest-score drop. Category-specific drops belong in gradingPolicies only. Never set dropLowest true just because quizzes or homework drop scores.

POLICY RULES:
- Record every explicit grading exception as its own gradingPolicies item. Never collapse distinct rules into a generic drop_lowest.
- Every policy must include: type, appliesTo (the category/assessment, e.g. quizzes, attendance, unit_exams, in_class_assignments, course), description (paraphrase the syllabus), appliesToCalculation (boolean), informationalOnly (boolean). Include quantity when N is stated. Include calculationEffect naming the actual mechanism.
- Use these types only: drop_lowest, drop_highest, keep_highest, keep_best_n, lowest_n, free_pass, attendance_allowance, excused_absence, makeup_exam, exam_replacement, extra_credit, bonus_points, late_penalty, late_grace, optional_assignment, score_replacement, missed_assignment, informational, grading_conflict, other.
- drop_lowest / lowest_n: only when the syllabus says the lowest N scores in a category are dropped. appliesTo that category only.
- keep_highest / keep_best_n: only when the syllabus says the highest/best N count. NOT the same as drop_lowest.
- free_pass: never convert to drop_lowest. calculationEffect must be do_not_treat_as_drop_lowest.
- attendance_allowance / excused_absence: preserve the stated mechanism (excused, recovery window, exam reweighting). Do NOT model as drop_lowest attendance unless the syllabus literally drops attendance scores.
- exam_replacement: e.g. final replaces a lower unit exam if higher. Not drop_lowest.
- extra_credit / bonus: informationalOnly true and appliesToCalculation false unless an explicit percentage weight is given.
- If two statements conflict or a sample calculation disagrees with the policy text, DO NOT pick one. Emit both policies with requiresVerification true and appliesToCalculation false, plus a grading_conflict item with severity "warning", sourceStatements quoting both, and requiresVerification true.
- Multiple policies may apply to the same category.
- If a rule is ambiguous, set appliesToCalculation false, informationalOnly true, and requiresVerification true rather than guessing.

Syllabus:
`;

type ParsedComponent = {
  id?: string;
  name?: string;
  weight?: number;
  total?: number;
  category?: string;
  [key: string]: unknown;
};

type ParsedPolicy = {
  type?: string;
  appliesTo?: string;
  component?: string;
  quantity?: number;
  count?: number;
  description?: string;
  [key: string]: unknown;
};

type ParsedSyllabus = {
  components?: ParsedComponent[];
  gradingPolicies?: ParsedPolicy[];
  [key: string]: unknown;
};

interface AssessmentKind {
  stems: string[];
  singular: string;
  plural: string;
  idPrefix: string;
  pattern: string;
}

interface RepeatSpec {
  kind: AssessmentKind;
  n: number;
  dropCount: number;
  eachPercent?: number;
  categoryWeight?: number;
}

const ASSESSMENT_KINDS: AssessmentKind[] = [
  { stems: ["in-class assignment", "in class assignment"], singular: "In-class Assignment", plural: "In-class Assignments", idPrefix: "ica", pattern: "in[- ]class assignments?" },
  { stems: ["problem set", "pset", "p-set"], singular: "Problem Set", plural: "Problem Sets", idPrefix: "pset", pattern: "problem sets?|p-?sets?" },
  { stems: ["homework", "hw"], singular: "Homework", plural: "Homework", idPrefix: "hw", pattern: "homework assignments?|homeworks?|\\bhw\\b" },
  { stems: ["quiz", "quizzes"], singular: "Quiz", plural: "Quizzes", idPrefix: "quiz", pattern: "quizzes|\\bquiz(?:zes)?" },
  { stems: ["assignment"], singular: "Assignment", plural: "Assignments", idPrefix: "asgn", pattern: "assignments?" },
  { stems: ["discussion"], singular: "Discussion", plural: "Discussions", idPrefix: "disc", pattern: "discussions?" },
  { stems: ["recitation"], singular: "Recitation", plural: "Recitations", idPrefix: "rec", pattern: "recitations?" },
  { stems: ["lab"], singular: "Lab", plural: "Labs", idPrefix: "lab", pattern: "labs?" },
  { stems: ["project"], singular: "Project", plural: "Projects", idPrefix: "proj", pattern: "projects?" },
  { stems: ["paper"], singular: "Paper", plural: "Papers", idPrefix: "paper", pattern: "papers?" },
  { stems: ["exam"], singular: "Exam", plural: "Exams", idPrefix: "exam", pattern: "exams?" },
];

const MATH_REPEAT_POLICY_TYPES = new Set([
  "drop_lowest",
  "lowest_n",
  "keep_highest",
  "keep_best_n",
]);

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40,
};

for (const [tens, value] of [["twenty", 20], ["thirty", 30]] as const) {
  const ones = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"] as const;
  ones.forEach((one, index) => {
    NUMBER_WORDS[`${tens}-${one}`] = value + index + 1;
    NUMBER_WORDS[`${tens} ${one}`] = value + index + 1;
  });
}

const NUMBER_WORD_ALTERNATION = Object.keys(NUMBER_WORDS)
  .sort((a, b) => b.length - a.length)
  .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[-\\s]"))
  .join("|");

const COUNT_TOKEN = `(?:\\d+|${NUMBER_WORD_ALTERNATION})`;

function parseCountToken(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().toLowerCase().replace(/-/g, " ");
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    return Number.isInteger(value) ? value : undefined;
  }
  const value = NUMBER_WORDS[trimmed] ?? NUMBER_WORDS[trimmed.replace(/\s+/g, " ")];
  return value;
}

function isParsedSyllabus(value: unknown): value is ParsedSyllabus {
  return typeof value === "object" && value !== null;
}

function kindFromLabel(label: string): AssessmentKind | undefined {
  const normalized = label.trim().toLowerCase().replace(/_/g, " ");
  return ASSESSMENT_KINDS.find((kind) =>
    kind.stems.some((stem) =>
      normalized === stem
      || normalized === `${stem}s`
      || normalized === kind.singular.toLowerCase()
      || normalized === kind.plural.toLowerCase()
    )
  );
}

function numberedNameRe(kind: AssessmentKind): RegExp {
  const singular = kind.singular.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const plural = kind.plural.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:${singular}|${plural})(?:\\s*\\d+)?$`, "i");
}

function aggregateNameRe(kind: AssessmentKind): RegExp {
  const plural = kind.plural.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const singular = kind.singular.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:graded |weekly |short |required |in[- ]class )?(?:${plural}|${singular})$`, "i");
}

function componentMatchesKind(component: ParsedComponent, kind: AssessmentKind): boolean {
  const category = (component.category ?? "").trim();
  const name = (component.name ?? "").trim();
  if (category && kindFromLabel(category) === kind) return true;
  if (numberedNameRe(kind).test(name) || aggregateNameRe(kind).test(name)) return true;
  return false;
}

function looksNumbered(name: string, kind: AssessmentKind): boolean {
  const singular = kind.singular.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const plural = kind.plural.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:${singular}|${plural})\\s*\\d+$`, "i").test(name.trim());
}

function dropCountIn(window: string): number {
  const lowestN = window.match(new RegExp(`lowest\\s+(${COUNT_TOKEN})\\s+(?:\\w+\\s+){0,6}(?:scores?\\s+)?(?:will be |are |is )?dropped`, "i"));
  if (lowestN) {
    const count = parseCountToken(lowestN[1]);
    if (count && count > 0) return count;
  }
  const dropLowestN = window.match(new RegExp(`drop(?:s|ped|ping)?\\s+(?:the\\s+)?lowest\\s+(${COUNT_TOKEN})`, "i"));
  if (dropLowestN) {
    const count = parseCountToken(dropLowestN[1]);
    if (count && count > 0) return count;
  }
  if (/lowest\s+(?:\w+\s+){0,4}(?:score\s+)?(?:will be |is |are )?dropped/i.test(window)) return 1;
  if (/drop(?:s|ped|ping)?\s+(?:the\s+)?lowest\b/i.test(window)) return 1;
  return 0;
}

function eachPercentIn(window: string): number | undefined {
  const patterns = [
    /(\d+(?:\.\d+)?)\s*%\s*each/i,
    /(?:will\s+)?each\s+(?:count|counts|counted|worth|weighs|weighted)(?:\s+for)?\s+(\d+(?:\.\d+)?)\s*%/i,
    /each\s+(?:will\s+)?(?:count|counts|counted|worth|weighs|weighted)(?:\s+for)?\s+(\d+(?:\.\d+)?)\s*%/i,
    /each\s+(?:is\s+)?worth\s+(\d+(?:\.\d+)?)\s*%/i,
  ];
  for (const pattern of patterns) {
    const match = window.match(pattern);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function remainingCountIn(window: string, kind: AssessmentKind): number | undefined {
  const match = window.match(new RegExp(`remaining\\s+(${COUNT_TOKEN})\\s+(?:graded\\s+)?(?:${kind.pattern})`, "i"));
  return match ? parseCountToken(match[1]) : undefined;
}

function categoryTotalIn(window: string): number | undefined {
  const patterns = [
    /(\d+(?:\.\d+)?)\s*%\s*(?:total|combined|altogether|overall)/i,
    /(?:together\s+)?account(?:s)?\s+for\s+(\d+(?:\.\d+)?)\s*%/i,
  ];
  for (const pattern of patterns) {
    const match = window.match(pattern);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function windowAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 240);
  const end = Math.min(text.length, index + length + 560);
  return text.slice(start, end);
}

function findRepeatSpecs(syllabusText: string): RepeatSpec[] {
  const text = syllabusText.replace(/\u00a0/g, " ");
  const specs: RepeatSpec[] = [];

  for (const kind of ASSESSMENT_KINDS) {
    const countRe = new RegExp(`(${COUNT_TOKEN})\\s+(?:(?:short|graded|required|weekly|in[- ]class)\\s+)*(?:${kind.pattern})\\b`, "gi");
    for (const match of text.matchAll(countRe)) {
      const n = parseCountToken(match[1]);
      if (n == null || n < 2 || n > 40) continue;
      const window = windowAround(text, match.index ?? 0, match[0].length);
      const remaining = remainingCountIn(window, kind);
      const dropCount = dropCountIn(window) || (remaining != null && remaining < n ? n - remaining : 0);
      const eachPercent = eachPercentIn(window);
      const remainingForWeight = remaining ?? (dropCount > 0 ? n - dropCount : n);
      const categoryWeight = remainingForWeight > 0 && eachPercent != null
        ? remainingForWeight * eachPercent
        : categoryTotalIn(window);
      specs.push({ kind, n, dropCount, eachPercent, categoryWeight });
    }

    const remainingRe = new RegExp(
      `remaining\\s+(${COUNT_TOKEN})\\s+(?:graded\\s+)?(?:${kind.pattern})[\\s\\S]{0,120}?(?:(?:will\\s+)?each\\s+(?:count|counts|worth|weighs|weighted)(?:\\s+for)?\\s+(\\d+(?:\\.\\d+)?)\\s*%|(\\d+(?:\\.\\d+)?)\\s*%\\s*each)`,
      "gi"
    );
    for (const match of text.matchAll(remainingRe)) {
      const remaining = parseCountToken(match[1]);
      const eachPercent = Number(match[2] ?? match[3]);
      if (remaining == null || remaining < 1 || remaining > 40) continue;
      if (!Number.isFinite(eachPercent) || eachPercent <= 0) continue;
      const window = windowAround(text, match.index ?? 0, match[0].length);
      const dropCount = dropCountIn(window) || 0;
      const nFromWindow = window.match(new RegExp(`(${COUNT_TOKEN})\\s+(?:(?:short|graded|required|weekly|in[- ]class)\\s+)*(?:${kind.pattern})\\b`, "i"));
      const n = nFromWindow ? parseCountToken(nFromWindow[1]) : remaining + dropCount;
      if (n == null || n < 2 || n > 40) continue;
      specs.push({
        kind,
        n,
        dropCount: dropCount || Math.max(0, n - remaining),
        eachPercent,
        categoryWeight: remaining * eachPercent,
      });
    }
  }

  const byKind = new Map<string, RepeatSpec>();
  for (const spec of specs) {
    const key = spec.kind.plural;
    const existing = byKind.get(key);
    const score = (spec.eachPercent != null ? 4 : 0) + (spec.dropCount > 0 ? 2 : 0) + (spec.categoryWeight != null ? 1 : 0);
    const existingScore = existing
      ? (existing.eachPercent != null ? 4 : 0) + (existing.dropCount > 0 ? 2 : 0) + (existing.categoryWeight != null ? 1 : 0)
      : -1;
    if (!existing || score > existingScore || (score === existingScore && spec.n > existing.n)) {
      byKind.set(key, spec);
    }
  }
  return [...byKind.values()];
}

function policyEvidenceText(parsed: ParsedSyllabus): string {
  return (parsed.gradingPolicies ?? []).flatMap((policy) => {
    const statements = Array.isArray(policy.sourceStatements)
      ? policy.sourceStatements.filter((item): item is string => typeof item === "string")
      : [];
    return [
      policy.description,
      policy.appliesTo,
      policy.component,
      typeof policy.calculationEffect === "string" ? policy.calculationEffect : "",
      ...statements,
    ];
  }).filter((item): item is string => typeof item === "string" && item.trim().length > 0).join("\n");
}

function mergePolicyRepeatSpecs(parsed: ParsedSyllabus, specs: RepeatSpec[]): RepeatSpec[] {
  const merged = [...specs];
  for (const policy of parsed.gradingPolicies ?? []) {
    if (policy.type !== "drop_lowest" && policy.type !== "lowest_n") continue;
    const kind = kindFromLabel(policy.appliesTo ?? policy.component ?? "");
    if (!kind) continue;
    const quantityRaw = Number(policy.quantity ?? policy.count);
    const dropCount = Number.isFinite(quantityRaw) && quantityRaw > 0 ? Math.floor(quantityRaw) : 1;
    const existing = merged.find((spec) => spec.kind.plural === kind.plural);
    if (existing) {
      if (existing.dropCount <= 0) existing.dropCount = dropCount;
      continue;
    }
    const fromPolicyText = findRepeatSpecs([
      policy.description,
      ...(Array.isArray(policy.sourceStatements) ? policy.sourceStatements : []),
    ].filter((item): item is string => typeof item === "string").join("\n"))
      .find((spec) => spec.kind.plural === kind.plural);
    if (fromPolicyText) {
      merged.push({
        ...fromPolicyText,
        dropCount: fromPolicyText.dropCount > 0 ? fromPolicyText.dropCount : dropCount,
      });
    }
  }
  return merged;
}

function weightsEqual(components: ParsedComponent[]): boolean {
  const weights = components.map((component) => Number(component.weight)).filter((weight) => Number.isFinite(weight));
  if (weights.length !== components.length || weights.length === 0) return false;
  const min = Math.min(...weights);
  const max = Math.max(...weights);
  return max - min <= 1e-6;
}

function matchingRepeatComponents(components: ParsedComponent[], kind: AssessmentKind): ParsedComponent[] {
  return components.filter((component) => componentMatchesKind(component, kind));
}

function shouldExpandRepeat(matching: ParsedComponent[], spec: RepeatSpec): boolean {
  if (spec.eachPercent == null && spec.dropCount <= 0) return false;
  if (matching.length === spec.n) return false;
  if (matching.length === 0) return false;
  if (matching.length === 1) {
    const name = (matching[0].name ?? "").trim();
    return aggregateNameRe(spec.kind).test(name) || !looksNumbered(name, spec.kind);
  }
  if (!weightsEqual(matching)) return false;
  const remaining = spec.n - spec.dropCount;
  if (spec.dropCount > 0 && matching.length === remaining) {
    return matching.every((component) => {
      const name = (component.name ?? "").trim();
      return looksNumbered(name, spec.kind) || aggregateNameRe(spec.kind).test(name);
    });
  }
  return false;
}

function uniqueComponentId(base: string, used: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

function policyTargetsKind(policy: ParsedPolicy, kind: AssessmentKind): boolean {
  const label = (policy.appliesTo ?? policy.component ?? "").trim();
  if (!label) return false;
  return kindFromLabel(label) === kind;
}

function ensureDropPolicy(parsed: ParsedSyllabus, spec: RepeatSpec) {
  if (spec.dropCount <= 0) return;
  const policies = Array.isArray(parsed.gradingPolicies) ? parsed.gradingPolicies : [];
  const hasDrop = policies.some((policy) =>
    (policy.type === "drop_lowest" || policy.type === "lowest_n") && policyTargetsKind(policy, spec.kind)
  );
  if (hasDrop) return;
  const hasConflictingMath = policies.some((policy) =>
    typeof policy.type === "string"
    && MATH_REPEAT_POLICY_TYPES.has(policy.type)
    && policyTargetsKind(policy, spec.kind)
  );
  if (hasConflictingMath) return;
  policies.push({
    type: "drop_lowest",
    appliesTo: spec.kind.plural.toLowerCase(),
    quantity: spec.dropCount,
    description: `Lowest ${spec.dropCount} ${spec.kind.singular.toLowerCase()} score${spec.dropCount === 1 ? " is" : "s are"} dropped.`,
    calculationEffect: "exclude_lowest",
    appliesToCalculation: true,
    informationalOnly: false,
  });
  parsed.gradingPolicies = policies;
}

function expandRepeatedAssessments(parsed: unknown, syllabusText: string): unknown {
  if (!isParsedSyllabus(parsed) || !Array.isArray(parsed.components)) {
    return parsed;
  }

  const evidence = [syllabusText, policyEvidenceText(parsed)].filter((part) => part.trim()).join("\n");
  const specs = mergePolicyRepeatSpecs(parsed, findRepeatSpecs(evidence));
  if (specs.length === 0) return parsed;

  let components = [...parsed.components];
  for (const spec of specs) {
    const matching = matchingRepeatComponents(components, spec.kind);
    if (!shouldExpandRepeat(matching, spec)) continue;

    const matchingWeight = matching.reduce((sum, component) => {
      const weight = Number(component.weight);
      return Number.isFinite(weight) ? sum + weight : sum;
    }, 0);
    const categoryWeight = matchingWeight > 0 ? matchingWeight : spec.categoryWeight;
    if (!categoryWeight || categoryWeight <= 0) continue;

    const template = matching[0];
    const rowWeight = categoryWeight / spec.n;
    const usedIds = new Set(
      components
        .filter((component) => !matching.includes(component))
        .map((component) => component.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    );
    const expanded: ParsedComponent[] = Array.from({ length: spec.n }, (_, index) => {
      const n = index + 1;
      return {
        ...template,
        id: uniqueComponentId(`${spec.kind.idPrefix}${n}`, usedIds),
        name: `${spec.kind.singular} ${n}`,
        weight: rowWeight,
        total: Number.isFinite(Number(template.total)) ? Number(template.total) : 100,
        category: spec.kind.plural,
        earned: null,
      };
    });

    const firstIndex = components.findIndex((component) => matching.includes(component));
    const before: ParsedComponent[] = [];
    const after: ParsedComponent[] = [];
    for (let i = 0; i < components.length; i += 1) {
      if (matching.includes(components[i])) continue;
      if (i < firstIndex) before.push(components[i]);
      else after.push(components[i]);
    }
    components = [...before, ...expanded, ...after];
    parsed.components = components;
    ensureDropPolicy(parsed, spec);
  }

  return parsed;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGroqError(error: unknown): boolean {
  const status = typeof error === "object" && error && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;
  const code = typeof error === "object" && error && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (status === 503 || code === 503) return true;
  if (status === 429 || code === 429) return true;
  const message = error instanceof Error ? error.message : "";
  return message.includes("UNAVAILABLE") && message.includes("503");
}

function groqUserError(error: unknown): Error {
  if (error instanceof SyntaxError) {
    return new Error("The AI service returned an invalid response.");
  }
  if (isRetryableGroqError(error)) {
    return new Error(BUSY_ERROR);
  }
  const status = error instanceof APIError ? error.status : undefined;
  if (status === 401 || status === 403) {
    return new Error("The AI service rejected the request.");
  }
  if (status === 400) {
    return new Error("The AI service could not process this syllabus.");
  }
  return new Error("Failed to parse this syllabus. Please try again.");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function gradingWindowScore(window: string): number {
  const text = window.toLowerCase();
  let score = 0;
  const bump = (pattern: RegExp, points: number) => {
    if (pattern.test(text)) score += points;
  };
  bump(/%/, 1);
  bump(/\b(grading|evaluation|grade breakdown|course grade|weighted)\b/, 3);
  bump(/\b(quiz|quizzes)\b/, 3);
  bump(/\b(exam|exams|midterm|final exam)\b/, 2);
  bump(/\b(homework|assignment|assignments|lab|labs)\b/, 2);
  bump(/\battendance\b/, 2);
  bump(/\b(drop|dropped|dropping|lowest|highest|keep best|keep the highest)\b/, 3);
  bump(/\b(extra credit|bonus|penalty|late|makeup|make-up|replac|free pass|allowance|recovery)\b/, 2);
  bump(/\b(grading scale|letter grade|percent of the (?:final )?grade)\b/, 2);
  bump(/\b(title ix|disability|wellness|mental health|campus safety|equal opportunity|non-discrimination)\b/, -5);
  return score;
}

const GRADING_HIT_RE = /grading|evaluation|grade breakdown|course grade|weighted|\bquiz(?:zes)?\b|\bexams?\b|midterm|final exam|homework|assignments?|\blabs?\b|attendance|drop(?:ped|ping)?|lowest|highest|keep best|extra credit|bonus|penalty|makeup|make-up|replac(?:e|ement)|free pass|allowance|recovery|grading scale|letter grade|account(?:s)? for|\d+(?:\.\d+)?\s*%/gi;

interface TextSpan {
  start: number;
  end: number;
  score: number;
}

function mergeSpans(spans: TextSpan[]): TextSpan[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: TextSpan[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end + 40) {
      last.end = Math.max(last.end, current.end);
      last.score = Math.max(last.score, current.score);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

function collectGradingSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  for (const match of text.matchAll(GRADING_HIT_RE)) {
    const index = match.index ?? 0;
    const start = Math.max(0, index - GRADING_WINDOW_CONTEXT);
    const end = Math.min(text.length, index + match[0].length + GRADING_WINDOW_CONTEXT);
    const score = gradingWindowScore(text.slice(start, end));
    if (score >= MIN_WINDOW_SCORE) spans.push({ start, end, score });
  }
  return mergeSpans(spans);
}

function clipSpansToBudget(spans: TextSpan[], introEnd: number, maxChars: number): TextSpan[] {
  const introAllowance = introEnd;
  let selected = spans.filter((span) => span.end > introEnd);
  const spanChars = (items: TextSpan[]) =>
    introAllowance + items.reduce((sum, span) => sum + (span.end - span.start) + 2, 0);

  while (selected.length && spanChars(selected) > maxChars) {
    let dropIndex = -1;
    let lowest = Infinity;
    for (let i = 0; i < selected.length; i += 1) {
      if (selected[i].score >= 8) continue;
      if (selected[i].score < lowest) {
        lowest = selected[i].score;
        dropIndex = i;
      }
    }
    if (dropIndex < 0) {
      dropIndex = selected.length - 1;
      for (let i = 0; i < selected.length; i += 1) {
        if (selected[i].score < selected[dropIndex].score) dropIndex = i;
      }
    }
    selected.splice(dropIndex, 1);
  }

  if (spanChars(selected) > maxChars && selected.length) {
    const excess = spanChars(selected) - maxChars;
    const weakest = selected.reduce((min, span, index) =>
      span.score <= selected[min].score ? index : min, 0);
    const span = selected[weakest];
    span.end = Math.max(span.start + 80, span.end - excess);
  }
  return selected.sort((a, b) => a.start - b.start);
}

function reduceSyllabusForModel(syllabusText: string, promptPrefix: string): string {
  const text = syllabusText.slice(0, MAX_SYLLABUS_CHARS).replace(/\u00a0/g, " ");
  if (estimateTokens(promptPrefix + text) <= GROQ_SAFE_INPUT_TOKENS) return text;

  const prefixTokens = estimateTokens(promptPrefix);
  const syllabusTokenBudget = Math.max(800, GROQ_SAFE_INPUT_TOKENS - prefixTokens);
  const maxChars = Math.floor(syllabusTokenBudget * CHARS_PER_TOKEN_ESTIMATE);
  let introEnd = Math.min(text.length, SYLLABUS_INTRO_CHARS);
  let spans = clipSpansToBudget(collectGradingSpans(text), introEnd, maxChars);

  const stitch = () => {
    const parts: string[] = [];
    let cursor = 0;
    if (introEnd > 0) {
      parts.push(text.slice(0, introEnd).trim());
      cursor = introEnd;
    }
    for (const span of spans) {
      const start = Math.max(span.start, cursor);
      if (span.end <= start) continue;
      parts.push(text.slice(start, span.end).trim());
      cursor = span.end;
    }
    return parts.filter(Boolean).join("\n\n");
  };

  let reduced = stitch();
  while (spans.length && estimateTokens(promptPrefix + reduced) > GROQ_SAFE_INPUT_TOKENS) {
    let dropIndex = 0;
    for (let i = 1; i < spans.length; i += 1) {
      if (spans[i].score < spans[dropIndex].score) dropIndex = i;
    }
    spans.splice(dropIndex, 1);
    reduced = stitch();
  }
  while (introEnd > 400 && estimateTokens(promptPrefix + reduced) > GROQ_SAFE_INPUT_TOKENS) {
    introEnd = Math.max(400, introEnd - 200);
    reduced = stitch();
  }
  if (!reduced.trim()) return text.slice(0, maxChars);
  return reduced;
}

async function parseSyllabusWithGroq(
  text: string,
  apiKey: string
): Promise<unknown> {
  const groq = new Groq({ apiKey });
  const syllabusForModel = reduceSyllabusForModel(text, EXTRACTION_PROMPT_PREFIX);
  const contents = `${EXTRACTION_PROMPT_PREFIX}${syllabusForModel}`;
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [{ role: "user", content: contents }],
        response_format: { type: "json_object" },
        max_tokens: 8192,
        temperature: 0,
      });

      const raw = response.choices[0]?.message?.content?.trim();
      if (!raw) {
        throw new Error("Groq returned an empty response.");
      }

      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      return expandRepeatedAssessments(parsed, text);
    } catch (error) {
      if (error instanceof SyntaxError) throw groqUserError(error);
      lastError = error;
      const canRetry = isRetryableGroqError(error) && attempt < RETRY_DELAYS_MS.length;
      if (!canRetry) throw groqUserError(error);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  throw groqUserError(lastError);
}

async function parseSyllabusRequest(
  text: unknown,
  apiKey: string
): Promise<{ status: number; body: unknown }> {
  if (!apiKey) {
    return { status: 500, body: { error: "Syllabus parsing is not configured." } };
  }
  if (typeof text !== "string" || !text.trim()) {
    return { status: 400, body: { error: "Syllabus text is required." } };
  }
  try {
    return { status: 200, body: await parseSyllabusWithGroq(text, apiKey) };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to parse syllabus.";
    return { status: 502, body: { error: message } };
  }
}

type JsonRequest = IncomingMessage & { body?: unknown; method?: string };

function requestBody(req: JsonRequest): unknown {
  if (typeof req.body === "string" && req.body.trim()) {
    return JSON.parse(req.body);
  }
  if (req.body && typeof req.body === "object") {
    return req.body;
  }
  return {};
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export default async function handler(req: JsonRequest, res: ServerResponse) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  try {
    const body = requestBody(req) as { text?: unknown };
    const result = await parseSyllabusRequest(body.text, process.env.GROQ_API_KEY || "");
    sendJson(res, result.status, result.body);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to parse syllabus.";
    sendJson(res, 502, { error: message });
  }
}
