import { useEffect, useState, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

/* ─── Types ─────────────────────────────────────────────────── */
type GradingPolicyType =
  | "drop_lowest"
  | "drop_highest"
  | "keep_highest"
  | "keep_best_n"
  | "lowest_n"
  | "free_pass"
  | "attendance_allowance"
  | "attendance_grace"
  | "attendance_penalty"
  | "excused_absence"
  | "extra_credit"
  | "bonus_points"
  | "late_penalty"
  | "late_grace"
  | "exam_replacement"
  | "makeup_exam"
  | "score_replacement"
  | "optional_assignment"
  | "missed_assignment"
  | "participation_exception"
  | "assignment_exception"
  | "informational"
  | "grading_conflict"
  | "other";

interface ComponentComposition {
  name: string;
  role?: string;
  notes?: string;
}

interface GradingPolicy {
  type: GradingPolicyType;
  appliesTo?: string;
  component?: string;
  componentIds?: string[];
  relatedComponents?: string[];
  quantity?: number;
  count?: number;
  description: string;
  calculationEffect?: string;
  appliesToCalculation: boolean;
  informationalOnly?: boolean;
  applies: "grade" | "info";
  severity?: "warning" | "info";
  requiresVerification?: boolean;
  sourceStatements?: string[];
}

interface Component {
  id: string;
  name: string;
  weight: number;
  earned: number | null;
  total: number;
  dropGroup?: string;
  category?: string;
  composition?: ComponentComposition[];
}
interface GradeCutoff {
  label: string;
  min: number;
  gpa: number;
}
interface Course {
  id: string;
  ownerId?: string;
  code: string;
  name: string;
  professor: string;
  credits?: number;
  dropLowest: boolean;
  penaltyNote?: string;
  components: Component[];
  gradeScale?: GradeCutoff[];
  gradeScaleSource?: "parsed" | "fallback";
  gpaMax?: number;
  gradingPolicies?: GradingPolicy[];
  parsedFromSyllabus?: boolean;
}

interface UserWorkspace {
  userId: string;
  courses: Course[];
  selectedId: string;
  inputsByCourse: Record<string, Record<string, string>>;
  target: string;
}

const LOCAL_USER_KEY = "gradepilot.localUserId";
const WORKSPACE_KEY = "gradepilot.workspace.v1";

function getLocalUserId(): string {
  try {
    const existing = localStorage.getItem(LOCAL_USER_KEY);
    if (existing) return existing;
    const userId = `local_${crypto.randomUUID()}`;
    localStorage.setItem(LOCAL_USER_KEY, userId);
    return userId;
  } catch {
    return "local_anonymous";
  }
}

function emptyWorkspace(userId: string): UserWorkspace {
  return { userId, courses: [], selectedId: "", inputsByCourse: {}, target: "A" };
}

function loadWorkspace(userId: string): UserWorkspace {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (!raw) return emptyWorkspace(userId);
    const parsed = JSON.parse(raw) as Partial<UserWorkspace>;
    const courses = Array.isArray(parsed.courses)
      ? parsed.courses.filter((course): course is Course =>
          Boolean(course?.id && Array.isArray(course.components) && course.parsedFromSyllabus)
        ).map((course) => {
          const parsedScale = course.gradeScaleSource === "parsed" && Boolean(course.gradeScale?.length);
          return {
            ...course,
            gradeScale: parsedScale ? course.gradeScale : FALLBACK_GRADES.map((grade) => ({ ...grade })),
            gradeScaleSource: parsedScale ? "parsed" as const : "fallback" as const,
          };
        })
      : [];
    const selectedId = courses.some((course) => course.id === parsed.selectedId)
      ? parsed.selectedId as string
      : (courses[0]?.id ?? "");
    return {
      userId,
      courses,
      selectedId,
      inputsByCourse: parsed.inputsByCourse && typeof parsed.inputsByCourse === "object"
        ? parsed.inputsByCourse
        : {},
      target: typeof parsed.target === "string" ? parsed.target : "A",
    };
  } catch {
    return emptyWorkspace(userId);
  }
}

function saveWorkspace(workspace: UserWorkspace) {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
  } catch {
    /* ignore quota / private mode */
  }
}

/* ─── Grade scale ────────────────────────────────────────────── */
const FALLBACK_GRADES: GradeCutoff[] = [
  { label: "A",  min: 93.0, gpa: 4.0 },
  { label: "A-", min: 90.0, gpa: 3.7 },
  { label: "B+", min: 87.0, gpa: 3.3 },
  { label: "B",  min: 83.0, gpa: 3.0 },
  { label: "B-", min: 80.0, gpa: 2.7 },
  { label: "C+", min: 77.0, gpa: 2.3 },
  { label: "C",  min: 73.0, gpa: 2.0 },
  { label: "C-", min: 70.0, gpa: 1.7 },
  { label: "D",  min: 60.0, gpa: 1.0 },
  { label: "F",  min: 0.0,  gpa: 0.0 },
];

const GRADE_COLORS: Record<string, string> = {
  "A+": "#0a7c43", "A": "#15803d", "A-": "#16a34a",
  "B+": "#1d4ed8", "B": "#2563eb", "B-": "#3b82f6",
  "C+": "#b45309", "C": "#d97706", "C-": "#e08a1e",
  "D": "#dc2626",  "F": "#991b1b",
};

const BAR_COLORS = ["#cf3f4c", "#3b82f6", "#22b87a", "#a855f7", "#f59e0b"];
const ACCENT = "#cf3f4c";

function normalizeGradeLabel(label: string): string {
  return label.trim().toUpperCase();
}

function isTargetGradeLabel(label: string): boolean {
  return /^[ABCD](?:[+-])?$/.test(normalizeGradeLabel(label));
}

function gradesForCourse(course: Course): GradeCutoff[] {
  if (course.gradeScaleSource === "parsed" && course.gradeScale?.length) {
    return course.gradeScale;
  }
  return FALLBACK_GRADES;
}

function targetGradesForCourse(course: Course): string[] {
  const targets = gradesForCourse(course)
    .filter((grade) => isTargetGradeLabel(grade.label))
    .map((grade) => normalizeGradeLabel(grade.label));
  return targets.length ? targets : FALLBACK_GRADES.filter((grade) => isTargetGradeLabel(grade.label)).map((grade) => grade.label);
}

function minimumForTarget(scale: GradeCutoff[], target: string): number {
  const want = normalizeGradeLabel(target);
  const match = scale.find((grade) => normalizeGradeLabel(grade.label) === want);
  if (match && Number.isFinite(match.min)) return match.min;
  const fallback = FALLBACK_GRADES.find((grade) => grade.label === want);
  return fallback?.min ?? 93.0;
}

function integerScoreNeeded(needed: number): number {
  if (!Number.isFinite(needed)) return needed;
  if (needed > 100) return 101;
  if (needed <= 0) return 0;
  return Math.ceil(needed - 1e-9);
}

function gradeFor(pct: number, scale: GradeCutoff[] = FALLBACK_GRADES) {
  return scale.find((g) => pct >= g.min) ?? scale[scale.length - 1];
}

function parseExplicitCredits(raw: unknown): number | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function courseCredits(course: Course): number | undefined {
  return parseExplicitCredits(course.credits);
}

function createCourseFromParse(data: Partial<Course>, ownerId: string): Course {
  const hasParsedScale = data.gradeScaleSource === "parsed" && Boolean(data.gradeScale?.length);
  return {
    id: `course_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ownerId,
    code: data.code?.trim() || "Course",
    name: data.name?.trim() || "Untitled course",
    professor: data.professor?.trim() || "",
    credits: parseExplicitCredits(data.credits),
    dropLowest: Boolean(data.dropLowest),
    penaltyNote: data.penaltyNote || undefined,
    components: (data.components ?? []).map((component) => ({
      ...component,
      earned: null,
    })),
    gradeScale: data.gradeScale?.length ? data.gradeScale : FALLBACK_GRADES.map((grade) => ({ ...grade })),
    gradeScaleSource: hasParsedScale ? "parsed" : "fallback",
    gpaMax: data.gpaMax,
    gradingPolicies: data.gradingPolicies,
    parsedFromSyllabus: true,
  };
}

/* ─── Drop-lowest ────────────────────────────────────────────── */
const MATH_POLICY_TYPES = new Set<GradingPolicyType>([
  "drop_lowest",
  "lowest_n",
  "keep_highest",
  "keep_best_n",
]);

function policyCount(policy: GradingPolicy): number {
  const value = policy.quantity ?? policy.count;
  return Number.isFinite(value) && (value as number) > 0
    ? Math.floor(value as number)
    : 1;
}

type PolicyChipKind =
  | "DROP LOWEST"
  | "KEEP BEST"
  | "PENALTY"
  | "BONUS"
  | "REPLACEMENT"
  | "FREE PASS"
  | "ALLOWANCE"
  | "MAKE-UP"
  | "RECOVERY"
  | "HARD CONSEQUENCE"
  | "CONFLICT";

interface PolicyChip {
  id: string;
  kind: PolicyChipKind;
  label: string;
  target?: string;
  general: string;
  specific: string;
}

const POLICY_CHIP_STYLES: Record<PolicyChipKind, { color: string; background: string }> = {
  "DROP LOWEST": { color: "#1d4ed8", background: "#eff6ff" },
  "KEEP BEST": { color: "#1d4ed8", background: "#eff6ff" },
  PENALTY: { color: "#92400e", background: "#fffbeb" },
  BONUS: { color: "#15803d", background: "#f0fdf4" },
  REPLACEMENT: { color: "#6d28d9", background: "#f5f3ff" },
  "FREE PASS": { color: "#0f766e", background: "#f0fdfa" },
  ALLOWANCE: { color: "#0f766e", background: "#f0fdfa" },
  "MAKE-UP": { color: "#0f766e", background: "#f0fdfa" },
  RECOVERY: { color: "#0f766e", background: "#f0fdfa" },
  "HARD CONSEQUENCE": { color: "#b91c1c", background: "#fef2f2" },
  CONFLICT: { color: "#b91c1c", background: "#fef2f2" },
};

const POLICY_CHIP_GENERAL: Record<PolicyChipKind, string> = {
  "DROP LOWEST": "The lowest N scores in a category are excluded from the course grade.",
  "KEEP BEST": "Only the highest N scores in a category count toward the course grade.",
  PENALTY: "The syllabus reduces a score or the course grade when a stated rule is broken.",
  BONUS: "Optional extra points. They are not a regular weighted component unless the syllabus gives them a percentage.",
  REPLACEMENT: "A later score can replace an earlier one when the stated condition is met.",
  "FREE PASS": "A limited number of items may be skipped. This is not the same as dropping the lowest scores.",
  ALLOWANCE: "A limited number of absences or misses are permitted under the stated conditions.",
  "MAKE-UP": "A missed assessment may be completed later only under the stated conditions.",
  RECOVERY: "A missed or excused item can be restored through the process described in the syllabus.",
  "HARD CONSEQUENCE": "Missing this requirement can cap or fail the course regardless of other scores.",
  CONFLICT: "The syllabus states grading rules that do not agree. Confirm the intended rule with the instructor.",
};

function formatWeightPercent(weight: number): string {
  if (!Number.isFinite(weight)) return "0";
  return parseFloat(weight.toFixed(2)).toString();
}

function sanitizeScoreInput(raw: string, max: number): { value: string; capped: boolean } | null {
  if (raw === "") return { value: "", capped: false };
  if (raw === ".") return { value: ".", capped: false };
  if (!/^\d*\.?\d*$/.test(raw)) return null;
  const num = parseFloat(raw);
  if (isNaN(num)) return null;
  if (num < 0) return { value: "0", capped: false };
  if (num > max) return { value: String(max), capped: true };
  return { value: raw, capped: false };
}

function numberedAssessmentParts(name: string): { stem: string; n: number } | null {
  const match = name.trim().match(/^(.*\S)\s+(\d+)$/);
  if (!match) return null;
  const n = Number(match[2]);
  if (!Number.isInteger(n) || n < 1) return null;
  return { stem: match[1].trim(), n };
}

function isExamLikeStem(stem: string): boolean {
  return /^(unit|exam|midterm|final)s?$/i.test(stem.trim());
}

function pluralizeAssessmentWord(word: string): string {
  if (/homework$/i.test(word)) return word;
  if (/quiz$/i.test(word)) return /^[A-Z]/.test(word) ? "Quizzes" : "quizzes";
  if (/(?:s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function groupTitleForMembers(members: Component[]): string {
  const categories = [...new Set(members.map((item) => item.category?.trim()).filter(Boolean) as string[])];
  if (categories.length === 1) return categories[0];
  const stem = numberedAssessmentParts(members[0].name)?.stem ?? members[0].name;
  const words = stem.split(/\s+/);
  const last = words[words.length - 1];
  words[words.length - 1] = pluralizeAssessmentWord(last);
  return words.join(" ");
}

function assessmentListEntries(components: Component[]): Array<
  | { type: "item"; component: Component }
  | { type: "group"; key: string; title: string; members: Component[] }
> {
  const stemCount = new Map<string, number>();
  for (const component of components) {
    const parts = numberedAssessmentParts(component.name);
    if (!parts || isExamLikeStem(parts.stem)) continue;
    const key = parts.stem.toLowerCase();
    stemCount.set(key, (stemCount.get(key) ?? 0) + 1);
  }
  const consumed = new Set<string>();
  const entries: Array<
    | { type: "item"; component: Component }
    | { type: "group"; key: string; title: string; members: Component[] }
  > = [];
  for (const component of components) {
    if (consumed.has(component.id)) continue;
    const parts = numberedAssessmentParts(component.name);
    const key = parts && !isExamLikeStem(parts.stem) ? parts.stem.toLowerCase() : null;
    if (key && (stemCount.get(key) ?? 0) >= 2) {
      const members = components.filter((item) => {
        const itemParts = numberedAssessmentParts(item.name);
        return itemParts && !isExamLikeStem(itemParts.stem) && itemParts.stem.toLowerCase() === key;
      });
      for (const member of members) consumed.add(member.id);
      entries.push({ type: "group", key, title: groupTitleForMembers(members), members });
    } else {
      entries.push({ type: "item", component });
    }
  }
  return entries;
}

function formatPolicyTarget(policy: GradingPolicy): string | undefined {
  const raw = (policy.appliesTo ?? policy.component ?? "").trim();
  if (!raw || /^(course|all|entire course)$/i.test(raw)) return undefined;
  return raw
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function policyTextBlob(policy: GradingPolicy): string {
  return [
    policy.description,
    policy.calculationEffect,
    ...(policy.sourceStatements ?? []),
  ].filter(Boolean).join(" ").toLowerCase();
}

function isHardConsequencePolicy(policy: GradingPolicy): boolean {
  return /grade of e\b|receive a grade of e|receive an e\b|fail the course|failing grade|regardless of (their )?performance|letter grade of e/.test(policyTextBlob(policy));
}

function isRecoveryPolicy(policy: GradingPolicy): boolean {
  return /\brecover/.test(policyTextBlob(policy));
}

function policyCategoryKey(policy: GradingPolicy): string {
  return (policy.appliesTo ?? policy.component ?? "").trim().toLowerCase();
}

function isMathDropOrKeep(type: GradingPolicyType): boolean {
  return type === "drop_lowest" || type === "lowest_n" || type === "keep_highest" || type === "keep_best_n";
}

function conflictCategories(policies: GradingPolicy[]): Set<string> {
  const flagged = new Set<string>();
  const mathByCategory: Record<string, Set<string>> = {};
  for (const policy of policies) {
    const category = policyCategoryKey(policy);
    if (!category || category === "course" || category === "all" || category === "entire course") continue;
    if (policy.type === "grading_conflict") flagged.add(category);
    if (!isMathDropOrKeep(policy.type)) continue;
    const family = (policy.type === "keep_highest" || policy.type === "keep_best_n") ? "keep" : "drop";
    if (!mathByCategory[category]) mathByCategory[category] = new Set();
    mathByCategory[category].add(family);
  }
  for (const [category, families] of Object.entries(mathByCategory)) {
    if (families.has("drop") && families.has("keep")) flagged.add(category);
  }
  return flagged;
}

function conflictChipSpecific(policies: GradingPolicy[], category: string): string {
  const related = policies.filter((policy) => {
    const key = policyCategoryKey(policy);
    return key === category && (policy.type === "grading_conflict" || isMathDropOrKeep(policy.type));
  });
  const statements = related.flatMap((policy) => {
    const quoted = (policy.sourceStatements ?? []).map((text) => `"${text}"`);
    if (quoted.length) return quoted;
    return policy.description.trim() ? [policy.description.trim()] : [];
  });
  const unique = [...new Set(statements)];
  if (unique.length) {
    return `The syllabus contains conflicting instructions for this category and does not resolve which rule to use. ${unique.join(" ")}`;
  }
  return "The syllabus contains conflicting grading instructions for this category and does not resolve which rule to use.";
}

function mapPolicyToChip(policy: GradingPolicy, index: number): PolicyChip | undefined {
  const target = formatPolicyTarget(policy);
  const specificParts = [
    policy.description.trim(),
    ...(policy.sourceStatements ?? []),
  ].filter((text, idx, list) => text && list.indexOf(text) === idx);
  const specific = specificParts.join(" ");
  const quantity = policyCount(policy);
  const id = `${policy.type}-${index}`;

  const chip = (kind: PolicyChipKind, label: string): PolicyChip => ({
    id,
    kind,
    label,
    target,
    general: POLICY_CHIP_GENERAL[kind],
    specific,
  });

  if (policy.type === "grading_conflict") return chip("CONFLICT", "CONFLICT");
  if (isHardConsequencePolicy(policy)) return chip("HARD CONSEQUENCE", "HARD CONSEQUENCE");
  if (policy.type === "drop_lowest" || policy.type === "lowest_n") {
    return chip("DROP LOWEST", `DROP LOWEST ${quantity}`);
  }
  if (policy.type === "keep_highest" || policy.type === "keep_best_n") {
    return chip("KEEP BEST", `KEEP BEST ${quantity}`);
  }
  if (policy.type === "free_pass") return chip("FREE PASS", "FREE PASS");
  if (policy.type === "makeup_exam") return chip("MAKE-UP", "MAKE-UP");
  if (policy.type === "exam_replacement" || policy.type === "score_replacement") {
    return chip("REPLACEMENT", "REPLACEMENT");
  }
  if (policy.type === "extra_credit" || policy.type === "bonus_points") return chip("BONUS", "BONUS");
  if (policy.type === "late_penalty" || policy.type === "attendance_penalty") {
    if (!specific) return undefined;
    return chip("PENALTY", "PENALTY");
  }
  if (isRecoveryPolicy(policy)) return chip("RECOVERY", "RECOVERY");
  if (
    policy.type === "attendance_allowance"
    || policy.type === "attendance_grace"
    || policy.type === "excused_absence"
    || policy.type === "late_grace"
  ) {
    return chip("ALLOWANCE", "ALLOWANCE");
  }
  return undefined;
}

function policyChipsForCourse(course: Course): PolicyChip[] {
  const policies = course.gradingPolicies ?? [];
  const blocked = conflictCategories(policies);
  const chips: PolicyChip[] = [];
  for (const [index, policy] of policies.entries()) {
    if (isMathDropOrKeep(policy.type) && blocked.has(policyCategoryKey(policy))) continue;
    const chip = mapPolicyToChip(policy, index);
    if (chip) chips.push(chip);
  }
  for (const category of blocked) {
    const target = formatPolicyTarget({
      type: "grading_conflict",
      description: "conflict",
      appliesToCalculation: false,
      applies: "info",
      appliesTo: category,
    });
    if (chips.some((chip) => chip.kind === "CONFLICT" && (chip.target ?? "").toLowerCase() === (target ?? "").toLowerCase())) {
      continue;
    }
    chips.unshift({
      id: `conflict-${category}`,
      kind: "CONFLICT",
      label: "CONFLICT",
      target,
      general: POLICY_CHIP_GENERAL.CONFLICT,
      specific: conflictChipSpecific(policies, category),
    });
  }
  return chips;
}

function PolicyTagChip({ chip }: { chip: PolicyChip }) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const colors = POLICY_CHIP_STYLES[chip.kind];
  const open = pinned || hovered;

  useEffect(() => {
    if (!pinned) return;
    const close = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setPinned(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [pinned]);

  return (
    <div
      ref={wrapRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}
    >
      <span style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 9,
        color: colors.color,
        background: colors.background,
        padding: "2px 6px",
        borderRadius: 4,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}>
        {chip.label}
        <button
          type="button"
          aria-label={`${chip.label} policy details`}
          onClick={(event) => { event.stopPropagation(); setPinned((value) => !value); }}
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            border: `1px solid ${colors.color}`,
            background: "#fff",
            color: colors.color,
            fontSize: 8,
            fontWeight: 800,
            lineHeight: "10px",
            padding: 0,
            cursor: "pointer",
          }}
        >
          i
        </button>
      </span>
      {chip.target && (
        <span style={{ fontSize: 8, color: "#888", fontWeight: 600, paddingRight: 2 }}>{chip.target}</span>
      )}
      {open && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            zIndex: 20,
            marginTop: 4,
            width: 220,
            background: "#fff",
            border: "1px solid #ebebeb",
            borderRadius: 8,
            boxShadow: "0 8px 20px rgba(0,0,0,0.08)",
            padding: "8px 10px",
            textAlign: "left",
          }}
        >
          <div style={{ fontSize: 9, fontWeight: 800, color: colors.color, marginBottom: 4 }}>{chip.label}</div>
          <div style={{ fontSize: 10, color: "#555", lineHeight: 1.45, marginBottom: 6 }}>{chip.general}</div>
          <div style={{ fontSize: 10, color: "#333", lineHeight: 1.45 }}>{chip.specific}</div>
        </div>
      )}
    </div>
  );
}

function matchesPolicyComponent(component: Component, policy: GradingPolicy): boolean {
  if (policy.componentIds?.includes(component.id)) return true;
  const label = (policy.appliesTo ?? policy.component)?.trim().toLowerCase();
  if (!label) return false;
  const category = component.category?.trim().toLowerCase();
  const group = component.dropGroup?.trim().toLowerCase();
  const name = component.name.trim().toLowerCase();
  if (category === label || group === label || name === label) return true;
  if (category?.includes(label) || label.includes(category ?? "\0")) return true;
  const singular = label.replace(/ies$/, "y").replace(/s$/, "").replace(/_/g, " ");
  return name.startsWith(singular) || (category?.replace(/_/g, " ").startsWith(singular) ?? false);
}

function componentsForPolicy(course: Course, policy: GradingPolicy): Component[] {
  return course.components.filter((component) => matchesPolicyComponent(component, policy));
}

function applyDropLowest(course: Course, scores: Record<string, number>): Record<string, number> {
  if (!course.dropLowest) return scores;
  const grouped: Record<string, { id: string; pct: number }[]> = {};
  for (const c of course.components) {
    const g = c.dropGroup ?? "__none__";
    const score = scores[c.id];
    if (score === undefined) continue;
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push({ id: c.id, pct: (score / c.total) * 100 });
  }
  const dropped = new Set<string>();
  for (const [group, items] of Object.entries(grouped)) {
    if (group === "__none__" || items.length < 2) continue;
    dropped.add(items.reduce((a, b) => (a.pct < b.pct ? a : b)).id);
  }
  const result: Record<string, number> = {};
  for (const [id, val] of Object.entries(scores)) {
    if (!dropped.has(id)) result[id] = val;
  }
  return result;
}

function idsToDropForPolicy(
  course: Course,
  scores: Record<string, number>,
  policy: GradingPolicy
): string[] {
  const matched = componentsForPolicy(course, policy)
    .map((component) => {
      const score = scores[component.id];
      if (score === undefined) return null;
      return { id: component.id, pct: (score / component.total) * 100 };
    })
    .filter((item): item is { id: string; pct: number } => item !== null);
  if (matched.length < 2) return [];
  const count = Math.min(policyCount(policy), matched.length - 1);
  if (count <= 0) return [];
  const keepCount = Math.max(1, Math.min(count, matched.length));
  if (policy.type === "keep_highest" || policy.type === "keep_best_n") {
    return [...matched].sort((a, b) => b.pct - a.pct).slice(keepCount).map((item) => item.id);
  }
  return [...matched].sort((a, b) => a.pct - b.pct).slice(0, count).map((item) => item.id);
}

function applyGradingPolicies(course: Course, scores: Record<string, number>): Record<string, number> {
  const dropped = droppedIdsForScores(course, scores);
  if (dropped.size === 0) return scores;
  const result: Record<string, number> = {};
  for (const [id, val] of Object.entries(scores)) {
    if (!dropped.has(id)) result[id] = val;
  }
  return result;
}

function droppedIdsForScores(course: Course, scores: Record<string, number>): Set<string> {
  const dropped = new Set<string>();
  const blocked = conflictCategories(course.gradingPolicies ?? []);
  for (const policy of course.gradingPolicies ?? []) {
    if (policy.applies !== "grade" || !MATH_POLICY_TYPES.has(policy.type)) continue;
    if (blocked.has(policyCategoryKey(policy))) continue;
    for (const id of idsToDropForPolicy(course, scores, policy)) dropped.add(id);
  }
  return dropped;
}

function effectiveWeights(course: Course, scores: Record<string, number>): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const component of course.components) weights[component.id] = component.weight;

  const dropped = droppedIdsForScores(course, scores);
  const blocked = conflictCategories(course.gradingPolicies ?? []);
  for (const policy of course.gradingPolicies ?? []) {
    if (policy.applies !== "grade" || !MATH_POLICY_TYPES.has(policy.type)) continue;
    if (blocked.has(policyCategoryKey(policy))) continue;
    const members = componentsForPolicy(course, policy);
    if (members.length < 2) continue;
    const categoryWeight = members.reduce((sum, component) => sum + component.weight, 0);
    const remaining = members.filter((component) => !dropped.has(component.id));
    if (remaining.length === 0 || categoryWeight <= 0) continue;
    const share = categoryWeight / remaining.length;
    for (const component of members) {
      weights[component.id] = dropped.has(component.id) ? 0 : share;
    }
  }
  return weights;
}

function scoreForComponent(
  component: Component,
  inputs: Record<string, string>
): number | undefined {
  if (Object.prototype.hasOwnProperty.call(inputs, component.id)) {
    const value = parseFloat(inputs[component.id]);
    return isNaN(value) ? undefined : value;
  }
  return component.earned ?? undefined;
}

/* ─── Core math ──────────────────────────────────────────────── */
function computeProjected(course: Course, inputs: Record<string, string>): number | null {
  const raw: Record<string, number> = {};
  for (const component of course.components) {
    const score = scoreForComponent(component, inputs);
    if (score !== undefined) raw[component.id] = score;
  }
  const afterCourseDrop = applyDropLowest(course, raw);
  const weights = effectiveWeights(course, afterCourseDrop);
  const scores = applyGradingPolicies(course, afterCourseDrop);
  let ws = 0, tw = 0;
  for (const component of course.components) {
    const score = scores[component.id];
    if (score === undefined) continue;
    const weight = weights[component.id] ?? component.weight;
    if (weight <= 0) continue;
    ws += (score / component.total) * 100 * weight;
    tw += weight;
  }
  return tw > 0 ? ws / tw : null;
}

function withAssumedPending(
  course: Course,
  inputs: Record<string, string>,
  assumedPct: number,
  overrideId?: string,
  overridePct?: number
): Record<string, string> {
  const next = { ...inputs };
  for (const component of course.components) {
    if (component.id === overrideId && overridePct !== undefined) {
      next[component.id] = String((overridePct / 100) * component.total);
      continue;
    }
    if (scoreForComponent(component, inputs) === undefined) {
      next[component.id] = String((assumedPct / 100) * component.total);
    }
  }
  return next;
}

function solveRequiredScore(targetPct: number, projectedAt: (scorePct: number) => number): number {
  if (projectedAt(0) >= targetPct) return 0;
  if (projectedAt(100) < targetPct) return 101;
  if (projectedAt(targetPct) >= targetPct) {
    const justBelow = Math.max(0, targetPct - 1e-6);
    if (projectedAt(justBelow) < targetPct) return targetPct;
  }

  let low = 0;
  let high = 100;
  for (let i = 0; i < 32; i++) {
    const midpoint = (low + high) / 2;
    if (projectedAt(midpoint) >= targetPct) high = midpoint;
    else low = midpoint;
  }
  if (projectedAt(targetPct) >= targetPct && high >= targetPct) return targetPct;
  return high;
}

function requiredOn(
  course: Course,
  targetPct: number,
  compId: string,
  inputs: Record<string, string>,
  assumeOtherPending = 100
): number {
  const component = course.components.find((item) => item.id === compId);
  if (!component) return NaN;

  return solveRequiredScore(targetPct, (scorePct) =>
    computeProjected(course, withAssumedPending(course, inputs, assumeOtherPending, compId, scorePct)) ?? 0
  );
}

function requiredAcrossPending(
  course: Course,
  targetPct: number,
  inputs: Record<string, string>
): number {
  const pending = course.components.filter(
    (component) => scoreForComponent(component, inputs) === undefined
  );
  if (pending.length === 0) return NaN;

  const projectedAt = (scorePct: number) => {
    const simulatedInputs = { ...inputs };
    for (const component of pending) {
      simulatedInputs[component.id] = String((scorePct / 100) * component.total);
    }
    return computeProjected(course, simulatedInputs) ?? 0;
  };

  return solveRequiredScore(targetPct, projectedAt);
}

function safetyRange(course: Course, inputs: Record<string, string>) {
  const pending = course.components.some(
    (component) => scoreForComponent(component, inputs) === undefined
  );
  if (!pending) {
    const projected = computeProjected(course, inputs) ?? 0;
    return { minPct: projected, maxPct: projected };
  }
  return {
    minPct: computeProjected(course, withAssumedPending(course, inputs, 0)) ?? 0,
    maxPct: computeProjected(course, withAssumedPending(course, inputs, 100)) ?? 0,
  };
}

/* ─── PDF + AI ───────────────────────────────────────────────── */
async function extractPdfText(file: File): Promise<string> {
  const ab = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= Math.min(pdf.numPages, 15); i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((x: any) => x.str).join(" "));
  }
  return pages.join("\n");
}

function cutoffMentionedInSyllabus(text: string, min: number): boolean {
  const variants = new Set([
    String(min),
    min.toFixed(1),
    String(Math.trunc(min)),
  ]);
  if (Number.isInteger(min)) variants.add(`${min}.0`);
  const haystack = text.replace(/,/g, "");
  for (const token of variants) {
    const escaped = token.replace(/\./g, "\\.");
    if (new RegExp(`(?:^|\\D)${escaped}(?:\\D|$)`).test(haystack)) return true;
  }
  return false;
}

async function parseSyllabus(text: string): Promise<Partial<Course>> {
  const res = await fetch("/api/parse-syllabus", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 80_000) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error ?? `API ${res.status}`);
  const parsed = data;
  const gradeScale = Array.isArray(parsed.gradeScale)
    ? parsed.gradeScale
        .filter((grade: any) => typeof grade?.label === "string" && Number.isFinite(Number(grade?.min)))
        .map((grade: any) => {
          const label = grade.label.trim().toUpperCase();
          return {
            label,
            min: Number(grade.min),
            gpa: Number.isFinite(Number(grade.gpa)) ? Number(grade.gpa) : 0,
          };
        })
        .sort((a: GradeCutoff, b: GradeCutoff) => b.min - a.min)
    : undefined;
  if (gradeScale?.length && !gradeScale.some((grade: GradeCutoff) => grade.label === "F")) {
    gradeScale.push({ label: "F", min: 0, gpa: 0 });
  }
  const attestedLetters = (gradeScale ?? []).filter((grade: GradeCutoff) => {
    if (grade.label === "F") return true;
    return cutoffMentionedInSyllabus(text, grade.min);
  });
  const explicitLetterCount = attestedLetters.filter((grade: GradeCutoff) => grade.label !== "F").length;
  const explicitScale = explicitLetterCount >= 4 ? attestedLetters : undefined;
  const explicitGpaMax = Number.isFinite(Number(parsed.gpaMax)) && Number(parsed.gpaMax) > 0
    ? Number(parsed.gpaMax)
    : undefined;
  const hasParsedScale = Boolean(explicitScale?.length);
  const gradingPolicies = normalizeGradingPolicies(parsed.gradingPolicies);
  const courseWideDrop = (gradingPolicies ?? []).some((policy) => {
    const target = (policy.appliesTo ?? policy.component ?? "").trim().toLowerCase();
    return (policy.type === "drop_lowest" || policy.type === "lowest_n")
      && policy.appliesToCalculation
      && (target === "course" || target === "all" || target === "entire course");
  });
  return {
    ...parsed,
    dropLowest: courseWideDrop,
    components: parsed.components.map((c: any) => ({
      ...c,
      earned: null,
      total: c.total ?? 100,
      category: typeof c.category === "string" && c.category.trim() ? c.category.trim() : undefined,
      composition: Array.isArray(c.composition)
        ? c.composition
            .filter((part: any) => typeof part?.name === "string" && part.name.trim())
            .map((part: any) => ({
              name: part.name.trim(),
              role: typeof part.role === "string" ? part.role.trim() : undefined,
              notes: typeof part.notes === "string" ? part.notes.trim() : undefined,
            }))
        : undefined,
    })),
    gradeScale: hasParsedScale ? explicitScale : FALLBACK_GRADES.map((grade) => ({ ...grade })),
    gradeScaleSource: hasParsedScale ? "parsed" : "fallback",
    gpaMax: explicitGpaMax,
    credits: parseExplicitCredits(parsed.credits),
    gradingPolicies,
  };
}

const POLICY_TYPES = new Set<string>([
  "drop_lowest",
  "drop_highest",
  "keep_highest",
  "keep_best_n",
  "lowest_n",
  "free_pass",
  "attendance_allowance",
  "attendance_grace",
  "attendance_penalty",
  "excused_absence",
  "extra_credit",
  "bonus_points",
  "late_penalty",
  "late_grace",
  "exam_replacement",
  "makeup_exam",
  "score_replacement",
  "optional_assignment",
  "missed_assignment",
  "participation_exception",
  "assignment_exception",
  "informational",
  "grading_conflict",
  "other",
]);

function normalizeGradingPolicies(raw: unknown): GradingPolicy[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const policies = raw.flatMap((item: any) => {
    if (!item || typeof item.description !== "string" || !item.description.trim()) return [];
    const mappedType = item.type === "lowest_n" ? "lowest_n" : item.type;
    const type = POLICY_TYPES.has(mappedType) ? mappedType as GradingPolicyType : "other";
    const quantityRaw = item.quantity ?? item.count;
    const quantity = Number.isFinite(Number(quantityRaw)) && Number(quantityRaw) > 0
      ? Math.floor(Number(quantityRaw))
      : undefined;
    const appliesTo = typeof item.appliesTo === "string" && item.appliesTo.trim()
      ? item.appliesTo.trim()
      : (typeof item.component === "string" && item.component.trim() ? item.component.trim() : undefined);
    const componentIds = Array.isArray(item.componentIds)
      ? item.componentIds.filter((id: unknown) => typeof id === "string")
      : undefined;
    const relatedComponents = Array.isArray(item.relatedComponents)
      ? item.relatedComponents.filter((id: unknown) => typeof id === "string")
      : undefined;
    const sourceStatements = Array.isArray(item.sourceStatements)
      ? item.sourceStatements.filter((text: unknown) => typeof text === "string" && text.trim()).map((text: string) => text.trim())
      : undefined;
    const informationalOnly = item.informationalOnly === true || type === "grading_conflict" || type === "informational";
    const requiresVerification = item.requiresVerification === true || type === "grading_conflict";
    const appliesToCalculation = informationalOnly || requiresVerification
      ? false
      : item.appliesToCalculation === true || item.applies === "grade";
    const applies: "grade" | "info" = MATH_POLICY_TYPES.has(type) && appliesToCalculation ? "grade" : "info";
    return [{
      type,
      appliesTo,
      component: appliesTo,
      componentIds: componentIds?.length ? componentIds : undefined,
      relatedComponents: relatedComponents?.length ? relatedComponents : undefined,
      quantity,
      count: quantity,
      description: item.description.trim(),
      calculationEffect: typeof item.calculationEffect === "string" && item.calculationEffect.trim()
        ? item.calculationEffect.trim()
        : undefined,
      appliesToCalculation,
      informationalOnly,
      applies,
      severity: item.severity === "warning" || item.severity === "info" ? item.severity : (type === "grading_conflict" ? "warning" : undefined),
      requiresVerification: requiresVerification || undefined,
      sourceStatements: sourceStatements?.length ? sourceStatements : undefined,
    }];
  });
  return policies.length ? policies : undefined;
}

/* ─── File icon ──────────────────────────────────────────────── */
function FileIcon({ size = 36, color = ACCENT }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} fill="none" stroke={color} strokeWidth="1.4" viewBox="0 0 24 24">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M16 13H8M16 17H8M10 9H8" />
    </svg>
  );
}

/* ─── App ────────────────────────────────────────────────────── */
export default function App() {
  const [ownerId] = useState(getLocalUserId);
  const [courses, setCourses] = useState<Course[]>(() => loadWorkspace(getLocalUserId()).courses);
  const [selectedId, setSelectedId] = useState(() => loadWorkspace(getLocalUserId()).selectedId);
  const [inputsByCourse, setInputsByCourse] = useState<Record<string, Record<string, string>>>(
    () => loadWorkspace(getLocalUserId()).inputsByCourse
  );
  const [target, setTarget] = useState(() => loadWorkspace(getLocalUserId()).target);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [uploadError, setUploadError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [showWelcome, setShowWelcome] = useState(() => loadWorkspace(getLocalUserId()).courses.length === 0);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [scoreLimitHintId, setScoreLimitHintId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    saveWorkspace({
      userId: ownerId,
      courses,
      selectedId,
      inputsByCourse,
      target,
    });
  }, [ownerId, courses, selectedId, inputsByCourse, target]);

  const course = courses.find((c) => c.id === selectedId) ?? courses[0] ?? null;
  const courseGrades = course ? gradesForCourse(course) : FALLBACK_GRADES;
  const inputs = course ? (inputsByCourse[course.id] ?? {}) : {};
  const remaining = course
    ? course.components.filter((component) => scoreForComponent(component, inputs) === undefined)
    : [];
  const setInput = (id: string, val: string, max: number) => {
    if (!course) return;
    const sanitized = sanitizeScoreInput(val, max);
    if (!sanitized) return;
    setScoreLimitHintId(sanitized.capped ? id : (current) => (current === id ? null : current));
    setInputsByCourse((previous) => ({
      ...previous,
      [course.id]: {
        ...(previous[course.id] ?? {}),
        [id]: sanitized.value,
      },
    }));
  };

  const projected = course ? computeProjected(course, inputs) : null;
  const projGrade = projected !== null ? gradeFor(projected, courseGrades) : null;
  const targetMin = minimumForTarget(courseGrades, target);
  const { minPct, maxPct } = course ? safetyRange(course, inputs) : { minPct: 0, maxPct: 0 };
  const targetSecured = minPct >= targetMin;
  const targetImpossible = maxPct < targetMin;

  const sharedNeeded = course ? requiredAcrossPending(course, targetMin, inputs) : NaN;
  const targetRequirements = remaining.map((component) => ({
    component,
    needed: sharedNeeded,
  }));

  const nextTarget = courseGrades[courseGrades.findIndex((g) => normalizeGradeLabel(g.label) === normalizeGradeLabel(target)) + 1];
  const diagType: "secured" | "impossible" | "inplay" = targetSecured ? "secured" : targetImpossible ? "impossible" : "inplay";

  const diagContent = {
    secured: {
      badge: "Goal Secured",
      badgeBg: "#dcfce7", badgeColor: "#15803d",
      note: `Even scoring 0 on everything remaining, you still reach ${target}. Take a breath.`,
    },
    impossible: {
      badge: "Not Achievable",
      badgeBg: "#fee2e2", badgeColor: "#dc2626",
      note: `Even perfect scores max out at ${maxPct.toFixed(1)}% (${gradeFor(maxPct, courseGrades).label}). ${nextTarget ? `Redirect to ${nextTarget.label} — it's within reach.` : ""}`,
    },
    inplay: {
      badge: "Goal Achievable",
      badgeBg: "#dcfce7", badgeColor: "#15803d",
      note: `Current floor ${minPct.toFixed(1)}% · ceiling ${maxPct.toFixed(1)}%.`,
    },
  }[diagType];

  // GPA
  const gpaItems = courses.map((c, i) => {
    const courseInputs = inputsByCourse[c.id] ?? {};
    const pg = computeProjected(c, courseInputs);
    const scale = gradesForCourse(c);
    const hasProjected = pg !== null;
    return {
      course: c,
      grade: hasProjected ? gradeFor(pg, scale) : null,
      pct: hasProjected ? pg : 0,
      color: BAR_COLORS[i % BAR_COLORS.length],
      gpaMax: c.gpaMax ?? 4,
      hasProjected,
    };
  });
  const gradedGpaItems = gpaItems.filter((item) => item.hasProjected && item.grade && courseCredits(item.course));
  const gradedCredits = gradedGpaItems.reduce((sum, { course: c }) => sum + (courseCredits(c) ?? 0), 0);
  const semGpa = gradedCredits
    ? gradedGpaItems.reduce((s, { course: c, grade: g }) => s + (g?.gpa ?? 0) * (courseCredits(c) as number), 0) / gradedCredits
    : null;
  const semGpaMax = gradedCredits
    ? gradedGpaItems.reduce((s, { course: c, gpaMax }) => s + gpaMax * (courseCredits(c) as number), 0) / gradedCredits
    : null;

  const handleFile = (f: File) => {
    if (f.type !== "application/pdf") { setUploadError("PDF files only."); return; }
    setUploadFile(f); setUploadError(""); setUploadStatus("idle");
  };

  const handleParse = async () => {
    if (!uploadFile) { setUploadError("Select a PDF first."); return; }
    setUploadStatus("working"); setUploadError("");
    try {
      const text = await extractPdfText(uploadFile);
      const data = await parseSyllabus(text);
      const parsedCourse = createCourseFromParse(data, ownerId);
      const parsedCode = parsedCourse.code.trim().toLowerCase();
      const existing = courses.find((item) => item.code.trim().toLowerCase() === parsedCode);
      const savedCourse = existing
        ? { ...parsedCourse, id: existing.id, ownerId: existing.ownerId }
        : parsedCourse;
      setCourses((prev) => {
        if (!existing) return [...prev, savedCourse];
        return prev.map((item) => item.id === existing.id ? savedCourse : item);
      });
      setSelectedId(savedCourse.id);
      setInputsByCourse((previous) => {
        const prior = existing ? (previous[existing.id] ?? {}) : {};
        const kept: Record<string, string> = {};
        for (const component of savedCourse.components) {
          if (Object.prototype.hasOwnProperty.call(prior, component.id)) {
            kept[component.id] = prior[component.id];
          }
        }
        const next = { ...previous, [savedCourse.id]: kept };
        if (existing && existing.id !== savedCourse.id) delete next[existing.id];
        return next;
      });
      const parsedTargets = targetGradesForCourse(parsedCourse);
      setTarget(parsedTargets.find((grade) => grade === "A") ?? parsedTargets[0] ?? "A");
      setUploadStatus("done");
      setShowWelcome(false);
    } catch (e: any) { setUploadError(e.message); setUploadStatus("error"); }
  };

  const targetButtons = course ? targetGradesForCourse(course) : [];

  // Drop check helper
  const droppedIds = (() => {
    if (!course) return new Set<string>();
    const allRaw: Record<string, number> = {};
    for (const c of course.components) {
      const score = scoreForComponent(c, inputs);
      if (score !== undefined) allRaw[c.id] = score;
    }
    const afterCourseDrop = applyDropLowest(course, allRaw);
    const kept = applyGradingPolicies(course, afterCourseDrop);
    return new Set(Object.keys(allRaw).filter((id) => !(id in kept)));
  })();

  if (showWelcome || !course) {
    return (
      <div className="welcome-shell">
        <div className="welcome-topbar">
          <div className="welcome-brand">
            <div className="gradepilot-mark welcome-mark">GP</div>
            <div>
              <div className="welcome-brand-name">GradePilot Engine</div>
              <div className="welcome-brand-note">AI-powered grade strategy</div>
            </div>
          </div>
          <div className="welcome-step">SETUP · 01</div>
        </div>

        <main className="welcome-main">
          <section className="welcome-copy">
            <div className="welcome-eyebrow">START YOUR GRADE PLAN</div>
            <div className="welcome-title">Start with your syllabus.</div>
            <div className="welcome-description">
              Upload one course syllabus and GradePilot will build the grading model for you.
              No manual setup, formulas, or cutoff hunting.
            </div>

            <div className="welcome-benefits">
              <div className="welcome-benefit">
                <div className="welcome-benefit-number">01</div>
                <div>
                  <div className="welcome-benefit-title">Extract course rules</div>
                  <div className="welcome-benefit-copy">Weights, drop policies, penalties, and grading cutoffs.</div>
                </div>
              </div>
              <div className="welcome-benefit">
                <div className="welcome-benefit-number">02</div>
                <div>
                  <div className="welcome-benefit-title">Add completed scores</div>
                  <div className="welcome-benefit-copy">Enter what you have earned and leave upcoming work blank.</div>
                </div>
              </div>
              <div className="welcome-benefit">
                <div className="welcome-benefit-number">03</div>
                <div>
                  <div className="welcome-benefit-title">Choose a target grade</div>
                  <div className="welcome-benefit-copy">See the minimum score needed across remaining work.</div>
                </div>
              </div>
            </div>
          </section>

          <section className="welcome-upload-card">
            <div className="welcome-upload-heading">
              <div className="welcome-upload-icon"><FileIcon size={22} /></div>
              <div>
                <div className="welcome-upload-title">Upload your first syllabus</div>
                <div className="welcome-upload-subtitle">PDF format · up to 8 pages analyzed</div>
              </div>
            </div>

            <div
              className={`welcome-dropzone${dragging ? " is-dragging" : ""}${uploadFile ? " has-file" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const file = event.dataTransfer.files[0];
                if (file) handleFile(file);
              }}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                style={{ display: "none" }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) handleFile(file);
                }}
              />
              <div className="welcome-drop-icon"><FileIcon size={30} color={uploadFile ? "#15803d" : ACCENT} /></div>
              <div className="welcome-drop-title">
                {uploadFile ? uploadFile.name : "Drop your syllabus PDF here"}
              </div>
              <div className="welcome-drop-note">
                {uploadFile ? "Ready for AI analysis" : "or click to browse from your computer"}
              </div>
            </div>

            {uploadError && <div className="welcome-message is-error">{uploadError}</div>}
            {uploadStatus === "done" && <div className="welcome-message is-success">Syllabus analyzed successfully.</div>}

            <div className="welcome-actions">
              <button
                className="welcome-primary-action"
                onClick={handleParse}
                disabled={uploadStatus === "working" || !uploadFile}
              >
                {uploadStatus === "working" ? "Analyzing syllabus..." : "Analyze syllabus"}
              </button>
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="gradepilot-shell" style={{
      height: "100vh", display: "flex", flexDirection: "column",
      background: "#f6f7f8", fontFamily: "Inter, system-ui, sans-serif", color: "#111",
      overflow: "hidden",
    }}>
      {/* ── Top bar ── */}
      <div className="gradepilot-topbar" style={{
        borderBottom: "1px solid #ebebeb", padding: "0 24px",
        height: 58, display: "flex", alignItems: "center", justifyContent: "space-between",
        flexShrink: 0, background: "#f6f7f8",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="gradepilot-mark" style={{ width: 32, height: 32, borderRadius: 9, background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "#fff", fontSize: 10, fontWeight: 800 }}>GP</span>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#111", letterSpacing: "-0.03em" }}>GradePilot Engine</div>
            <div style={{ fontSize: 9, color: "#8b919a", marginTop: 1 }}>AI-powered syllabus analysis and grade prediction</div>
          </div>
        </div>
        {/* Course tabs */}
        <div className="course-tabs" style={{ display: "flex", gap: 4 }}>
          {courses.map((c) => {
            const pg = computeProjected(c, inputsByCourse[c.id] ?? {});
            const gi = pg !== null ? gradeFor(pg, gradesForCourse(c)) : null;
            const active = c.id === selectedId;
            return (
              <button className={`course-tab${active ? " is-active" : ""}`} key={c.id} onClick={() => {
                const nextTargets = targetGradesForCourse(c);
                setSelectedId(c.id);
                if (!nextTargets.includes(target)) {
                  setTarget(nextTargets.find((grade) => grade === "A") ?? nextTargets[0] ?? "A");
                }
              }}
                style={{
                  padding: "6px 12px", borderRadius: 8, border: "1px solid",
                  borderColor: active ? ACCENT : "#e3e5e8",
                  background: active ? ACCENT : "#fff",
                  color: active ? "#fff" : "#777d86",
                  fontSize: 11, fontWeight: active ? 600 : 400, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 5,
                }}>
                <span style={{ fontFamily: "DM Mono, monospace", fontSize: 11 }}>{c.code}</span>
                {gi && <span style={{ fontFamily: "DM Mono, monospace", fontSize: 10, fontWeight: 700, color: active ? "#aaa" : (GRADE_COLORS[gi.label] ?? "#888") }}>{gi.label}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Page content ── */}
      <div className="gradepilot-content" style={{ flex: 1, overflow: "hidden", padding: "14px 24px 14px" }}>

        {/* Two-column grid — fills remaining height */}
        <div className="gradepilot-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 14, height: "100%", alignItems: "stretch", minHeight: 0 }}>

          {/* ── Left column ── */}
          <div className="gradepilot-left" style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", overflow: "hidden", minHeight: 0, minWidth: 0 }}>

            {/* Syllabus upload card — compact */}
            <div className="gp-card gp-upload-card" style={{ background: "#fff", border: "1px solid #ebebeb", borderRadius: 14, overflow: "hidden", flexShrink: 0 }}>
              <div style={{ padding: "11px 18px", borderBottom: "1px solid #f4f4f4", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>Syllabus Upload</div>
                  <div style={{ fontSize: 11, color: "#aaa" }}>AI extracts weights, hidden rules, and exact letter-grade cutoffs</div>
                </div>
                {course.parsedFromSyllabus && <span style={{ fontSize: 10, color: ACCENT, fontWeight: 700 }}>✦ AI Parsed</span>}
              </div>
              <div style={{ padding: "10px 18px 12px" }}>
                {/* Compact drop zone */}
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    border: `2px dashed ${dragging ? ACCENT : uploadFile ? "#16a34a" : "#e0e0e0"}`,
                    borderRadius: 9, padding: "10px 16px", cursor: "pointer",
                    background: dragging ? "#fff8f7" : uploadFile ? "#f0fdf4" : "#fafafa",
                    display: "flex", alignItems: "center", gap: 10, marginBottom: 8,
                  }}>
                  <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: "none" }}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
                  <FileIcon color={uploadFile ? "#16a34a" : "#ccc"} size={20} />
                  <span style={{ fontSize: 12, color: uploadFile ? "#15803d" : "#888", fontWeight: uploadFile ? 600 : 400 }}>
                    {uploadFile ? uploadFile.name : "Drop PDF here or click to browse"}
                  </span>
                </div>
                {uploadError && <div style={{ fontSize: 11, color: "#dc2626", marginBottom: 6 }}>{uploadError}</div>}
                {uploadStatus === "done" && <div style={{ fontSize: 11, color: "#15803d", marginBottom: 6 }}>✓ Applied to {course.code}.</div>}
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={handleParse} disabled={uploadStatus === "working" || !uploadFile}
                    style={{ flex: 1, padding: "7px 0", borderRadius: 8, border: "none", background: (!uploadFile || uploadStatus === "working") ? "#f0f0f0" : ACCENT, color: (!uploadFile || uploadStatus === "working") ? "#aaa" : "#fff", fontSize: 12, fontWeight: 700, cursor: uploadFile ? "pointer" : "default" }}>
                    {uploadStatus === "working" ? "Parsing…" : "Analyze with AI"}
                  </button>
                </div>
              </div>
            </div>

            {/* Assessment table */}
            <div className="gp-card" style={{ background: "#fff", border: "1px solid #ebebeb", borderRadius: 14, overflow: "hidden", flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "10px 18px 8px", borderBottom: "1px solid #f4f4f4", flexShrink: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>{course.code} — {course.name}</div>
                    <div style={{ fontSize: 11, color: "#aaa" }}>{[course.professor, courseCredits(course) != null ? `${courseCredits(course)} cr` : null].filter(Boolean).join(" · ")}</div>
                    <div className="score-entry-note">Enter completed scores below. Leave upcoming work blank.</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end", maxWidth: 220 }}>
                      {policyChipsForCourse(course).map((chip) => (
                        <PolicyTagChip key={chip.id} chip={chip} />
                      ))}
                    </div>
                    {projGrade && projected !== null && (
                      <div style={{ textAlign: "right" }}>
                        <span style={{ fontFamily: "DM Mono, monospace", fontSize: 18, fontWeight: 900, color: GRADE_COLORS[projGrade.label] ?? "#888" }}>{projGrade.label}</span>
                        <span style={{ fontFamily: "DM Mono, monospace", fontSize: 10, color: "#bbb", marginLeft: 4 }}>{projected.toFixed(1)}%</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Table header */}
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 60px 120px 50px", padding: "6px 18px", background: "#fafafa", borderBottom: "1px solid #f4f4f4", flexShrink: 0 }}>
                {["Assessment", "Wt.", "Score", "Gr."].map((h) => (
                  <div key={h} style={{ fontSize: 9, color: "#bbb", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</div>
                ))}
              </div>

              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
              {assessmentListEntries(course.components).map((entry, entryIndex, entries) => {
                const isLastEntry = entryIndex === entries.length - 1;
                const renderRow = (comp: Component, options?: { indent?: boolean; last?: boolean }) => {
                  const inputVal = Object.prototype.hasOwnProperty.call(inputs, comp.id)
                    ? inputs[comp.id]
                    : comp.earned?.toString() ?? "";
                  const num = parseFloat(inputVal);
                  const isPending = isNaN(num);
                  const pct = isPending ? null : (num / comp.total) * 100;
                  const gi = pct !== null ? gradeFor(pct, courseGrades) : null;
                  const isDropped = droppedIds.has(comp.id);
                  return (
                    <div key={comp.id} style={{
                      display: "grid", gridTemplateColumns: "minmax(0, 1fr) 60px 120px 50px",
                      padding: options?.indent ? "8px 18px 8px 28px" : "8px 18px", alignItems: "center",
                      borderBottom: options?.last ? "none" : "1px solid #f8f8f8",
                      opacity: isDropped ? 0.4 : 1,
                      background: isPending && !isDropped ? "#fdfcfb" : "#fff",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        <div style={{ width: 5, height: 5, borderRadius: "50%", flexShrink: 0, background: isPending ? "#ddd" : ACCENT }} />
                        <span style={{ fontSize: 12, color: "#111", fontWeight: 500, textDecoration: isDropped ? "line-through" : "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{comp.name}</span>
                        {isDropped && <span style={{ fontSize: 8, fontWeight: 700, color: "#bbb", background: "#f4f4f4", padding: "1px 4px", borderRadius: 3 }}>DROPPED</span>}
                      </div>
                      <div style={{ fontFamily: "DM Mono, monospace", fontSize: 11, color: "#888", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden" }}>{formatWeightPercent(comp.weight)}%</div>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            <input type="number" min={0} max={comp.total} step="any" placeholder="—"
                              value={inputVal} onChange={(e) => setInput(comp.id, e.target.value, comp.total)}
                              style={{ width: 54, padding: "4px 7px", border: "1.5px solid #e4e4e4", borderRadius: 6, fontSize: 13, fontFamily: "DM Mono, monospace", fontWeight: 700, outline: "none", color: "#111", textAlign: "center", background: "#fafafa" }}
                              onFocus={(e) => { e.target.style.borderColor = ACCENT; e.target.style.background = "#fff"; }}
                              onBlur={(e) => {
                                e.target.style.borderColor = "#e4e4e4";
                                e.target.style.background = "#fafafa";
                                setScoreLimitHintId((current) => current === comp.id ? null : current);
                              }}
                            />
                            <span style={{ fontSize: 10, color: "#ccc", fontFamily: "DM Mono, monospace" }}>/{comp.total}</span>
                          </div>
                          {scoreLimitHintId === comp.id && (
                            <div style={{ fontSize: 8, color: "#bbb", fontWeight: 600, marginTop: 2 }}>Max {comp.total}</div>
                          )}
                        </div>
                      <div>
                        {gi ? (
                          <span style={{ fontFamily: "DM Mono, monospace", fontSize: 11, fontWeight: 800, color: isPending ? "#bbb" : (GRADE_COLORS[gi.label] ?? "#888") }}>{gi.label}</span>
                        ) : <span className="pending-score-label">Pending</span>}
                      </div>
                    </div>
                  );
                };

                if (entry.type === "item") {
                  return renderRow(entry.component, { last: isLastEntry });
                }

                const groupId = `${course.id}:${entry.key}`;
                const expanded = expandedGroups[groupId] === true;
                const categoryWeight = entry.members.reduce((sum, member) => sum + member.weight, 0);
                const completed = entry.members.filter((member) => {
                  const inputVal = Object.prototype.hasOwnProperty.call(inputs, member.id)
                    ? inputs[member.id]
                    : member.earned?.toString() ?? "";
                  return !isNaN(parseFloat(inputVal));
                }).length;

                return (
                  <div key={groupId}>
                    <button
                      type="button"
                      onClick={() => setExpandedGroups((previous) => ({ ...previous, [groupId]: !expanded }))}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        padding: "8px 18px",
                        border: "none",
                        borderBottom: !expanded && isLastEntry ? "none" : "1px solid #f8f8f8",
                        background: "#fff",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        <span style={{ fontSize: 11, color: "#bbb", width: 10, flexShrink: 0 }}>{expanded ? "▾" : "▸"}</span>
                        <span style={{ fontSize: 12, color: "#111", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.title}</span>
                      </span>
                      <span style={{ fontFamily: "DM Mono, monospace", fontSize: 11, color: "#888", fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>
                        {formatWeightPercent(categoryWeight)}% · {completed}/{entry.members.length} completed
                      </span>
                    </button>
                    {expanded && entry.members.map((member, memberIndex) =>
                      renderRow(member, {
                        indent: true,
                        last: isLastEntry && memberIndex === entry.members.length - 1,
                      })
                    )}
                  </div>
                );
              })}
              </div>
            </div>

            <div className="gp-card gpa-card" style={{ background: "#fff", border: "1px solid #ebebeb", borderRadius: 14, padding: "12px 18px", flexShrink: 0, height: 152, boxSizing: "border-box", overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10, flexShrink: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>Estimated Semester GPA</div>
                <div>
                  <span style={{ fontFamily: "DM Mono, monospace", fontSize: 22, fontWeight: 900, color: "#111", letterSpacing: "-0.02em" }}>{semGpa === null ? "—" : semGpa.toFixed(2)}</span>
                  <span style={{ fontFamily: "DM Mono, monospace", fontSize: 12, color: "#bbb" }}> / {semGpaMax === null ? "—" : semGpaMax.toFixed(1)}</span>
                </div>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", paddingRight: 6 }}>
              {gpaItems.map(({ course: c, grade: g, pct, color, hasProjected }) => (
                <div key={c.id} style={{ marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#333" }}>{c.code}</div>
                      <div style={{ fontSize: 11, color: "#bbb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                    </div>
                    <span style={{ fontFamily: "DM Mono, monospace", fontSize: 14, fontWeight: 800, color: hasProjected && g ? (GRADE_COLORS[g.label] ?? "#888") : "#bbb", flexShrink: 0, marginLeft: 8 }}>{hasProjected && g ? g.label : "—"}</span>
                  </div>
                  <div style={{ height: 4, background: "#f0f0f0", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ width: `${hasProjected ? Math.max(0, Math.min(100, pct)) : 0}%`, height: "100%", background: color, borderRadius: 2, transition: "width 0.4s ease" }} />
                  </div>
                </div>
              ))}
              </div>
            </div>
          </div>

          {/* ── Right column ── */}
          <div className="gradepilot-right" style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", overflow: "hidden", minHeight: 0, minWidth: 0 }}>

            {/* Target grade card */}
            <div className="gp-card target-card" style={{ background: "#fff", border: "1px solid #ebebeb", borderRadius: 14, overflow: "hidden", flex: "0 1 auto", maxHeight: "100%", minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
              <div style={{ padding: "10px 18px 8px", borderBottom: "1px solid #f4f4f4", display: "flex", alignItems: "baseline", justifyContent: "space-between", flexShrink: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>Target Grade</div>
                <div style={{ fontSize: 10, color: course.gradeScaleSource === "parsed" ? ACCENT : "#aaa", fontWeight: course.gradeScaleSource === "parsed" ? 700 : 400 }}>
                  {course.gradeScaleSource === "parsed" ? `Syllabus scale · ${course.code}` : course.code}
                </div>
              </div>
              <div style={{ padding: "12px 18px 14px", flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                {/* Grade buttons */}
                <div className="target-grade-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginBottom: 12, flexShrink: 0 }}>
                  {targetButtons.map((g) => {
                    const active = target === g;
                    return (
                      <button className={`target-grade-button${active ? " is-active" : ""}`} key={g} onClick={() => setTarget(g)}
                        style={{
                          padding: "8px 6px", borderRadius: 9,
                          border: `2px solid ${active ? ACCENT : "#e8e8e8"}`,
                          background: active ? ACCENT : "#fff",
                          color: active ? "#fff" : "#aaa",
                          fontSize: 12, fontWeight: 800, fontFamily: "DM Mono, monospace",
                          cursor: "pointer", transition: "all 0.12s",
                          whiteSpace: "nowrap", minWidth: 0, boxSizing: "border-box",
                          letterSpacing: "0.02em",
                        }}>
                        {g}
                      </button>
                    );
                  })}
                </div>

                {/* Score hero */}
                <div className={`score-hero is-${diagType}`} style={{
                  borderRadius: 12, padding: "14px 16px", textAlign: "center",
                  background: diagType === "impossible" ? "#fef6f5" : diagType === "secured" ? "#f3fef6" : "#fef9f7",
                  border: `1.5px solid ${diagType === "impossible" ? "#fecaca" : diagType === "secured" ? "#bbf7d0" : "#f0e0dc"}`,
                  flexShrink: 0,
                }}>
                  <div style={{ fontSize: 10, color: "#aaa", marginBottom: 6 }}>
                    {remaining.length > 1
                      ? "Minimum needed on each pending assessment"
                      : remaining.length === 1
                        ? `Min. needed — ${remaining[0].name}`
                        : "Minimum required score"}
                  </div>

                  {diagType === "secured" ? (
                    <div style={{ fontFamily: "DM Mono, monospace", fontSize: 44, fontWeight: 900, color: "#15803d", lineHeight: 1 }}>✓</div>
                  ) : diagType === "impossible" ? (
                    <div style={{ fontFamily: "DM Mono, monospace", fontSize: 44, fontWeight: 900, color: "#dc2626", lineHeight: 1 }}>✕</div>
                  ) : !isNaN(sharedNeeded) ? (
                    <div style={{ lineHeight: 1 }}>
                      <span style={{ fontFamily: "DM Mono, monospace", fontSize: 50, fontWeight: 900, color: "#111", letterSpacing: "-0.03em" }}>
                        {integerScoreNeeded(sharedNeeded)}
                      </span>
                      <span style={{ fontFamily: "DM Mono, monospace", fontSize: 15, color: "#888", marginLeft: 2 }}>pts</span>
                    </div>
                  ) : (
                    <div style={{ fontFamily: "DM Mono, monospace", fontSize: 30, color: "#aaa" }}>—</div>
                  )}

                  <div style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    marginTop: 8, padding: "4px 12px", borderRadius: 20,
                    background: diagContent.badgeBg, color: diagContent.badgeColor,
                    fontSize: 10, fontWeight: 700,
                  }}>
                    {diagType !== "impossible" ? "✓" : "✕"} {diagContent.badge}
                  </div>

                  <div style={{ fontSize: 10, color: "#999", marginTop: 7, lineHeight: 1.55 }}>
                    {diagContent.note}
                  </div>
                </div>

                {targetRequirements.length > 1 && (
                  <div className="requirement-breakdown" style={{ flex: "1 1 auto", minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                    <div className="requirement-breakdown-heading" style={{ flexShrink: 0 }}>
                      <div>
                        <div className="requirement-breakdown-title">Shared minimum score</div>
                        <div className="requirement-breakdown-note">Earn at least this score on every pending assessment.</div>
                      </div>
                      <div className="requirement-target">{target} target</div>
                    </div>
                    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
                    {targetRequirements.map(({ component, needed }) => {
                      const status = needed > 100 ? "Not possible" : needed <= 0 ? "Any score" : `${integerScoreNeeded(needed)} pts`;
                      return (
                        <div className="requirement-row" key={component.id}>
                          <div>
                            <div className="requirement-name">{component.name}</div>
                            <div className="requirement-weight">{formatWeightPercent(component.weight)}% of course grade</div>
                          </div>
                          <div className={`requirement-score${needed > 100 ? " is-impossible" : needed <= 0 ? " is-secured" : ""}`}>
                            {status}
                          </div>
                        </div>
                      );
                    })}
                    </div>
                  </div>
                )}

                {/* Current projected */}
                {projGrade && projected !== null && (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, padding: "8px 12px", background: "#fafafa", borderRadius: 8, border: "1px solid #f0f0f0", flexShrink: 0 }}>
                    <span style={{ fontSize: 11, color: "#888" }}>Current projected</span>
                    <span style={{ fontFamily: "DM Mono, monospace", fontSize: 16, fontWeight: 900, color: GRADE_COLORS[projGrade.label] ?? "#888" }}>
                      {projGrade.label} <span style={{ fontSize: 10, fontWeight: 400, color: "#bbb" }}>{projected.toFixed(1)}%</span>
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
