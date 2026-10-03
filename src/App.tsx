import { useState, useRef } from "react";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

/* ─── Types ─────────────────────────────────────────────────── */
interface Component {
  id: string;
  name: string;
  weight: number;
  earned: number | null;
  total: number;
  dropGroup?: string;
}
interface GradeCutoff {
  label: string;
  min: number;
  gpa: number;
}
interface Course {
  id: string;
  code: string;
  name: string;
  professor: string;
  credits: number;
  dropLowest: boolean;
  penaltyNote?: string;
  components: Component[];
  gradeScale?: GradeCutoff[];
  gpaMax?: number;
  parsedFromSyllabus?: boolean;
}

/* ─── Seed data ──────────────────────────────────────────────── */
const INITIAL_COURSES: Course[] = [
  {
    id: "c1",
    code: "ACCTG 2100",
    name: "Financial Accounting",
    professor: "Prof. Kim Sunghee",
    credits: 3,
    dropLowest: false,
    components: [
      { id: "a1",    name: "Assignment 1", weight: 10, earned: 96,   total: 100 },
      { id: "a2",    name: "Assignment 2", weight: 10, earned: 92,   total: 100 },
      { id: "quiz1", name: "Quiz 1",       weight: 10, earned: 90,   total: 100 },
      { id: "mid",   name: "Midterm Exam", weight: 30, earned: 88,   total: 100 },
      { id: "final", name: "Final Exam",   weight: 40, earned: null, total: 100 },
    ],
  },
  {
    id: "c2",
    code: "MGT 1030",
    name: "Responsibilities of Business",
    professor: "Prof. Hak-Yoon Kim",
    credits: 3,
    dropLowest: false,
    penaltyNote: "3+ absences → −5 pts deducted from final grade",
    components: [
      { id: "r1",     name: "Reflection Paper 1", weight: 15, earned: 95,   total: 100 },
      { id: "r2",     name: "Reflection Paper 2", weight: 15, earned: 88,   total: 100 },
      { id: "grp",    name: "Group Project",       weight: 20, earned: null, total: 100 },
      { id: "mid2",   name: "Midterm Exam",        weight: 20, earned: 91,   total: 100 },
      { id: "final2", name: "Final Exam",          weight: 30, earned: null, total: 100 },
    ],
  },
  {
    id: "c3",
    code: "IS 2010",
    name: "Spreadsheet Analysis",
    professor: "Prof. Byoung-gyu Gong",
    credits: 2,
    dropLowest: true,
    components: [
      { id: "lab1",   name: "Lab 1",         weight: 15, earned: 100,  total: 100, dropGroup: "lab" },
      { id: "lab2",   name: "Lab 2",         weight: 15, earned: 93,   total: 100, dropGroup: "lab" },
      { id: "lab3",   name: "Lab 3",         weight: 15, earned: 82,   total: 100, dropGroup: "lab" },
      { id: "proj",   name: "Final Project", weight: 25, earned: null, total: 100 },
      { id: "final3", name: "Final Exam",    weight: 30, earned: null, total: 100 },
    ],
  },
];

/* ─── Grade scale ────────────────────────────────────────────── */
const GRADES = [
  { label: "A+", min: 95, gpa: 4.0 },
  { label: "A",  min: 90, gpa: 4.0 },
  { label: "A-", min: 87, gpa: 3.7 },
  { label: "B+", min: 83, gpa: 3.3 },
  { label: "B",  min: 80, gpa: 3.0 },
  { label: "B-", min: 77, gpa: 2.7 },
  { label: "C+", min: 73, gpa: 2.3 },
  { label: "C",  min: 70, gpa: 2.0 },
  { label: "C-", min: 67, gpa: 1.7 },
  { label: "D",  min: 60, gpa: 1.0 },
  { label: "F",  min: 0,  gpa: 0.0 },
];
const DEFAULT_TARGET_GRADES = ["A", "A-", "B", "B-", "C", "C-"];

const GRADE_COLORS: Record<string, string> = {
  "A+": "#0a7c43", "A": "#15803d", "A-": "#16a34a",
  "B+": "#1d4ed8", "B": "#2563eb", "B-": "#3b82f6",
  "C+": "#b45309", "C": "#d97706", "C-": "#e08a1e",
  "D": "#dc2626",  "F": "#991b1b",
};

const BAR_COLORS = ["#cf3f4c", "#3b82f6", "#22b87a", "#a855f7", "#f59e0b"];
const ACCENT = "#cf3f4c";

function gradesForCourse(course: Course): GradeCutoff[] {
  return course.gradeScale?.length ? course.gradeScale : GRADES;
}

function targetGradesForCourse(course: Course): string[] {
  if (!course.gradeScale?.length) return DEFAULT_TARGET_GRADES;
  const targets = course.gradeScale
    .filter((grade) => /^[ABC](?:[+-])?$/.test(grade.label))
    .map((grade) => grade.label);
  return targets.length ? targets : DEFAULT_TARGET_GRADES;
}

function gradeFor(pct: number, scale: GradeCutoff[] = GRADES) {
  return scale.find((g) => pct >= g.min) ?? scale[scale.length - 1];
}

/* ─── Drop-lowest ────────────────────────────────────────────── */
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
function buildScores(course: Course, inputs: Record<string, string>): Record<string, number> {
  const raw: Record<string, number> = {};
  for (const c of course.components) {
    const score = scoreForComponent(c, inputs);
    if (score !== undefined) raw[c.id] = score;
  }
  return applyDropLowest(course, raw);
}

function computeProjected(course: Course, inputs: Record<string, string>): number | null {
  const scores = buildScores(course, inputs);
  let ws = 0, tw = 0;
  for (const c of course.components) {
    const s = scores[c.id];
    if (s === undefined) continue;
    ws += (s / c.total) * 100 * c.weight;
    tw += c.weight;
  }
  return tw > 0 ? ws / tw : null;
}

function requiredOn(
  course: Course,
  targetPct: number,
  compId: string,
  inputs: Record<string, string>,
  assumeOtherPending = 100
): number {
  let fixed = 0, fixedW = 0, targetW = 0;
  const unsetPending: Component[] = [];
  for (const c of course.components) {
    if (c.id === compId) { targetW = c.weight; continue; }
    const score = scoreForComponent(c, inputs);
    if (score !== undefined) {
      fixed += (score / c.total) * 100 * c.weight;
      fixedW += c.weight;
    } else unsetPending.push(c);
  }
  for (const c of unsetPending) {
    fixed += (assumeOtherPending / c.total) * 100 * c.weight;
    fixedW += c.weight;
  }
  if (targetW === 0) return NaN;
  return (targetPct * (fixedW + targetW) - fixed) / targetW;
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

  if (projectedAt(0) >= targetPct) return 0;
  if (projectedAt(100) < targetPct) return 101;

  let low = 0;
  let high = 100;
  for (let i = 0; i < 32; i++) {
    const midpoint = (low + high) / 2;
    if (projectedAt(midpoint) >= targetPct) high = midpoint;
    else low = midpoint;
  }
  return high;
}

function safetyRange(course: Course, inputs: Record<string, string>) {
  const scores = buildScores(course, inputs);
  let fixedWS = 0, fixedW = 0, pendingW = 0;
  for (const c of course.components) {
    const s = scores[c.id];
    if (s !== undefined) {
      fixedWS += (s / c.total) * 100 * c.weight;
      fixedW += c.weight;
    } else {
      pendingW += c.weight;
    }
  }
  const totalW = fixedW + pendingW;
  return {
    minPct: totalW > 0 ? fixedWS / totalW : 0,
    maxPct: totalW > 0 ? (fixedWS + pendingW * 100) / totalW : 0,
  };
}

/* ─── PDF + AI ───────────────────────────────────────────────── */
async function extractPdfText(file: File): Promise<string> {
  const ab = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= Math.min(pdf.numPages, 8); i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((x: any) => x.str).join(" "));
  }
  return pages.join("\n");
}

async function parseSyllabus(text: string, apiKey: string): Promise<Partial<Course>> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5-20251101",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `Extract grading from this syllabus. Return ONLY valid JSON:
{"code":"CS 101","name":"course name","professor":"Prof. Name","credits":3,"dropLowest":false,"penaltyNote":null,"components":[{"id":"uid","name":"Component Name","weight":20,"total":100}],"gradeScale":[{"label":"A+","min":97,"gpa":4.0},{"label":"A","min":93,"gpa":4.0},{"label":"A-","min":90,"gpa":3.7}],"gpaMax":4.0}
Weights must sum to 100. Extract the exact custom letter-grade scale and percentage cutoffs stated in the syllabus. Include plus/minus grades only when explicitly present and sort from highest to lowest. Also extract GPA points per letter and gpaMax only when the syllabus explicitly states them. Return gradeScale as null when no exact cutoffs are stated and gpaMax as null when it is not stated. Syllabus:\n${text.slice(0, 6000)}`,
      }],
    }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error((e as any)?.error?.message ?? `API ${res.status}`); }
  const data = await res.json();
  const parsed = JSON.parse(data.content[0].text.replace(/```json|```/g, "").trim());
  const gradeScale = Array.isArray(parsed.gradeScale)
    ? parsed.gradeScale
        .filter((grade: any) => typeof grade?.label === "string" && Number.isFinite(Number(grade?.min)))
        .map((grade: any) => {
          const label = grade.label.trim().toUpperCase();
          return {
            label,
            min: Number(grade.min),
            gpa: Number.isFinite(Number(grade.gpa))
              ? Number(grade.gpa)
              : GRADES.find((item) => item.label === label)?.gpa ?? 0,
          };
        })
        .sort((a: GradeCutoff, b: GradeCutoff) => b.min - a.min)
    : undefined;
  if (gradeScale?.length && !gradeScale.some((grade: GradeCutoff) => grade.label === "F")) {
    gradeScale.push({ label: "F", min: 0, gpa: 0 });
  }
  const explicitGpaMax = Number.isFinite(Number(parsed.gpaMax)) && Number(parsed.gpaMax) > 0
    ? Number(parsed.gpaMax)
    : undefined;
  const inferredGpaMax = gradeScale?.length
    ? Math.max(...gradeScale.map((grade: GradeCutoff) => grade.gpa))
    : undefined;
  return {
    ...parsed,
    components: parsed.components.map((c: any) => ({ ...c, earned: null, total: c.total ?? 100 })),
    gradeScale: gradeScale?.length ? gradeScale : undefined,
    gpaMax: explicitGpaMax ?? inferredGpaMax,
  };
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
  const [courses, setCourses] = useState<Course[]>(INITIAL_COURSES);
  const [selectedId, setSelectedId] = useState("c1");
  const [inputsByCourse, setInputsByCourse] = useState<Record<string, Record<string, string>>>({});
  const [target, setTarget] = useState("A");
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem("gp_key") ?? "");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [uploadError, setUploadError] = useState("");
  const [showApiInput, setShowApiInput] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showWelcome, setShowWelcome] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const course = courses.find((c) => c.id === selectedId)!;
  const courseGrades = gradesForCourse(course);
  const inputs = inputsByCourse[selectedId] ?? {};
  const remaining = course.components.filter(
    (component) => scoreForComponent(component, inputs) === undefined
  );
  const setInput = (id: string, val: string) => {
    setInputsByCourse((previous) => ({
      ...previous,
      [selectedId]: {
        ...(previous[selectedId] ?? {}),
        [id]: val,
      },
    }));
  };

  const projected = computeProjected(course, inputs);
  const projGrade = projected !== null ? gradeFor(projected, courseGrades) : null;
  const targetMin = courseGrades.find((g) => g.label === target)?.min ?? courseGrades[0]?.min ?? 90;
  const { minPct, maxPct } = safetyRange(course, inputs);
  const targetSecured = minPct >= targetMin;
  const targetImpossible = maxPct < targetMin;

  const sharedNeeded = requiredAcrossPending(course, targetMin, inputs);
  const targetRequirements = remaining.map((component) => ({
    component,
    needed: sharedNeeded,
  }));

  const nextTarget = courseGrades[courseGrades.findIndex((g) => g.label === target) + 1];
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
    const { maxPct: mx } = safetyRange(c, courseInputs);
    const scale = gradesForCourse(c);
    const g = pg !== null ? gradeFor(pg, scale) : gradeFor(mx, scale);
    return {
      course: c,
      grade: g,
      pct: pg ?? mx,
      color: BAR_COLORS[i % BAR_COLORS.length],
      gpaMax: c.gpaMax ?? 4,
    };
  });
  const totalCredits = courses.reduce((s, c) => s + c.credits, 0);
  const semGpa = gpaItems.reduce((s, { course: c, grade: g }) => s + g.gpa * c.credits, 0) / totalCredits;
  const semGpaMax = gpaItems.reduce((s, { course: c, gpaMax }) => s + gpaMax * c.credits, 0) / totalCredits;

  const handleFile = (f: File) => {
    if (f.type !== "application/pdf") { setUploadError("PDF files only."); return; }
    setUploadFile(f); setUploadError(""); setUploadStatus("idle");
  };

  const handleParse = async () => {
    if (!uploadFile) { setUploadError("Select a PDF first."); return; }
    if (!apiKey.trim()) { setShowApiInput(true); setUploadError("Enter your Anthropic API key."); return; }
    sessionStorage.setItem("gp_key", apiKey.trim());
    setUploadStatus("working"); setUploadError("");
    try {
      const text = await extractPdfText(uploadFile);
      const data = await parseSyllabus(text, apiKey.trim());
      setCourses((prev) => prev.map((c) => c.id !== selectedId ? c : {
        ...c, ...data,
        components: (data.components?.length ?? 0) > 0 ? data.components! : c.components,
        parsedFromSyllabus: true,
      }));
      setInputsByCourse((previous) => ({ ...previous, [selectedId]: {} }));
      const parsedTargets = data.gradeScale
        ?.filter((grade) => /^[ABC](?:[+-])?$/.test(grade.label))
        .map((grade) => grade.label) ?? [];
      if (parsedTargets.length && !parsedTargets.includes(target)) {
        setTarget(parsedTargets.find((grade) => grade === "A") ?? parsedTargets[0]);
      }
      setUploadStatus("done");
      setShowWelcome(false);
    } catch (e: any) { setUploadError(e.message); setUploadStatus("error"); }
  };

  const cutoffGrades = courseGrades
    .filter((grade) => /^[ABC](?:[+-])?$/.test(grade.label))
    .map((grade) => grade.label);
  const targetButtons = targetGradesForCourse(course);

  // Drop check helper
  const droppedIds = (() => {
    const allRaw: Record<string, number> = {};
    for (const c of course.components) {
      const score = scoreForComponent(c, inputs);
      if (score !== undefined) allRaw[c.id] = score;
    }
    const kept = applyDropLowest(course, allRaw);
    return new Set(Object.keys(allRaw).filter((id) => !(id in kept)));
  })();

  if (showWelcome) {
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

            {showApiInput && (
              <div className="welcome-api-block">
                <input
                  className="welcome-api-input"
                  type="password"
                  placeholder="Anthropic API key  sk-ant-..."
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <div className="welcome-api-note">Required for this prototype and kept only for this browser session.</div>
              </div>
            )}

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
              <button className="welcome-secondary-action" onClick={() => setShowApiInput((value) => !value)}>
                {apiKey ? "AI connected" : "Connect AI"}
              </button>
            </div>

            <button className="welcome-demo-action" onClick={() => setShowWelcome(false)}>
              Preview with sample courses
            </button>
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
        <div className="gradepilot-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 14, height: "100%", alignItems: "start" }}>

          {/* ── Left column ── */}
          <div className="gradepilot-left" style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", overflow: "hidden" }}>

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
                {showApiInput && (
                  <div style={{ marginBottom: 8 }}>
                    <input type="password" placeholder="Anthropic API key  sk-ant-..." value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                      style={{ width: "100%", padding: "6px 10px", border: "1px solid #e4e4e4", borderRadius: 7, fontSize: 12, fontFamily: "DM Mono, monospace", outline: "none", boxSizing: "border-box" }} />
                    <div style={{ fontSize: 9, color: "#999", marginTop: 4 }}>
                      Required for this prototype. Kept only for the current browser session.
                    </div>
                  </div>
                )}
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
                  <button onClick={() => setShowApiInput((v) => !v)}
                    style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid #e4e4e4", background: "#fff", color: "#888", fontSize: 11, cursor: "pointer" }}>
                    Connect AI
                  </button>
                </div>
              </div>
            </div>

            {/* Assessment table */}
            <div className="gp-card" style={{ background: "#fff", border: "1px solid #ebebeb", borderRadius: 14, overflow: "hidden", flexShrink: 0 }}>
              <div style={{ padding: "10px 18px 8px", borderBottom: "1px solid #f4f4f4" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>{course.code} — {course.name}</div>
                    <div style={{ fontSize: 11, color: "#aaa" }}>{course.professor} · {course.credits} cr</div>
                    <div className="score-entry-note">Enter completed scores below. Leave upcoming work blank.</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {course.dropLowest && <span style={{ fontSize: 9, color: "#1d4ed8", background: "#eff6ff", padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>DROP LOWEST</span>}
                    {course.penaltyNote && <span style={{ fontSize: 9, color: "#92400e", background: "#fffbeb", padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>⚠ PENALTY</span>}
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
              <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 120px 50px", padding: "6px 18px", background: "#fafafa", borderBottom: "1px solid #f4f4f4" }}>
                {["Assessment", "Wt.", "Score", "Gr."].map((h) => (
                  <div key={h} style={{ fontSize: 9, color: "#bbb", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</div>
                ))}
              </div>

              {course.components.map((comp, i) => {
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
                    display: "grid", gridTemplateColumns: "1fr 60px 120px 50px",
                    padding: "8px 18px", alignItems: "center",
                    borderBottom: i < course.components.length - 1 ? "1px solid #f8f8f8" : "none",
                    opacity: isDropped ? 0.4 : 1,
                    background: isPending && !isDropped ? "#fdfcfb" : "#fff",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 5, height: 5, borderRadius: "50%", flexShrink: 0, background: isPending ? "#ddd" : ACCENT }} />
                      <span style={{ fontSize: 12, color: "#111", fontWeight: 500, textDecoration: isDropped ? "line-through" : "none" }}>{comp.name}</span>
                      {isDropped && <span style={{ fontSize: 8, fontWeight: 700, color: "#bbb", background: "#f4f4f4", padding: "1px 4px", borderRadius: 3 }}>DROPPED</span>}
                    </div>
                    <div style={{ fontFamily: "DM Mono, monospace", fontSize: 11, color: "#888", fontWeight: 600 }}>{comp.weight}%</div>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <input type="number" min={0} max={comp.total} placeholder="—"
                          value={inputVal} onChange={(e) => setInput(comp.id, e.target.value)}
                          style={{ width: 54, padding: "4px 7px", border: "1.5px solid #e4e4e4", borderRadius: 6, fontSize: 13, fontFamily: "DM Mono, monospace", fontWeight: 700, outline: "none", color: "#111", textAlign: "center", background: "#fafafa" }}
                          onFocus={(e) => { e.target.style.borderColor = ACCENT; e.target.style.background = "#fff"; }}
                          onBlur={(e) => { e.target.style.borderColor = "#e4e4e4"; e.target.style.background = "#fafafa"; }}
                        />
                        <span style={{ fontSize: 10, color: "#ccc", fontFamily: "DM Mono, monospace" }}>/{comp.total}</span>
                      </div>
                    </div>
                    <div>
                      {gi ? (
                        <span style={{ fontFamily: "DM Mono, monospace", fontSize: 11, fontWeight: 800, color: isPending ? "#bbb" : (GRADE_COLORS[gi.label] ?? "#888") }}>{gi.label}</span>
                      ) : <span className="pending-score-label">Pending</span>}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Grade cutoff table */}
            {remaining.length > 0 && (
              <div className="gp-card" style={{ background: "#fff", border: "1px solid #ebebeb", borderRadius: 14, overflow: "hidden", flex: 1, minHeight: 0 }}>
                <div style={{ padding: "10px 18px 8px", borderBottom: "1px solid #f4f4f4", display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>All-Grade Cutoff Table</div>
                  <div style={{ fontSize: 10, color: "#bbb" }}>min. score per remaining item</div>
                </div>
                <div style={{ overflowX: "auto", overflowY: "auto", height: "calc(100% - 41px)" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid #f0f0f0" }}>
                        <th style={{ textAlign: "left", padding: "6px 10px 6px 18px", fontSize: 9, color: "#bbb", fontWeight: 700, textTransform: "uppercase", position: "sticky", top: 0, background: "#fafafa" }}>Grade</th>
                        <th style={{ textAlign: "left", padding: "6px 10px", fontSize: 9, color: "#bbb", fontWeight: 700, textTransform: "uppercase", position: "sticky", top: 0, background: "#fafafa" }}>Cut</th>
                        {remaining.map((c) => (
                          <th key={c.id} style={{ textAlign: "right", padding: "6px 10px", fontSize: 9, color: "#bbb", fontWeight: 700, textTransform: "uppercase", whiteSpace: "nowrap", position: "sticky", top: 0, background: "#fafafa" }}>
                            {c.name.replace("Examination", "Exam").replace("Reflection Paper", "Reflection")}
                          </th>
                        ))}
                        <th style={{ textAlign: "right", padding: "6px 18px 6px 10px", fontSize: 9, color: "#bbb", fontWeight: 700, textTransform: "uppercase", position: "sticky", top: 0, background: "#fafafa" }}>Verdict</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cutoffGrades.map((gl) => {
                        const g = courseGrades.find((x) => x.label === gl)!;
                        const neededs = remaining.map((c) => requiredOn(course, g.min, c.id, inputs, 100));
                        const worst = Math.max(...neededs);
                        const allImp = neededs.every((n) => n > 100);
                        const allSec = neededs.every((n) => n <= 0);
                        const isTarget = gl === target;
                        const vc = allImp ? "#dc2626" : allSec ? "#15803d" : worst <= 75 ? "#15803d" : worst <= 88 ? "#2563eb" : "#b45309";
                        const vt = allImp ? "Impossible" : allSec ? "Secured ✓" : worst <= 75 ? "Safe" : worst <= 88 ? "Doable" : worst <= 95 ? "Hard push" : "Very tight";
                        return (
                          <tr key={gl} style={{ borderTop: "1px solid #f8f8f8", background: isTarget ? "#fdf9f8" : "transparent" }}>
                            <td style={{ padding: "7px 10px 7px 18px" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                <span style={{ fontFamily: "DM Mono, monospace", fontSize: 12, fontWeight: 800, color: GRADE_COLORS[gl] ?? "#888" }}>{gl}</span>
                                {isTarget && <span style={{ fontSize: 8, fontWeight: 700, color: ACCENT, background: "#fff0ed", padding: "1px 4px", borderRadius: 3 }}>TARGET</span>}
                              </div>
                            </td>
                            <td style={{ padding: "7px 10px", fontFamily: "DM Mono, monospace", fontSize: 10, color: "#bbb" }}>{g.min}%</td>
                            {neededs.map((n, i) => {
                              const imp = n > 100, sec = n <= 0;
                              return (
                                <td key={i} style={{ textAlign: "right", padding: "7px 10px" }}>
                                  <span style={{ fontFamily: "DM Mono, monospace", fontSize: 12, fontWeight: 700, color: imp ? "#dc2626" : sec ? "#15803d" : n > 90 ? "#b45309" : "#111" }}>
                                    {imp ? "N/A" : sec ? "Any" : Math.ceil(n)}
                                  </span>
                                </td>
                              );
                            })}
                            <td style={{ textAlign: "right", padding: "7px 18px 7px 10px" }}>
                              <span style={{ fontSize: 10, fontWeight: 700, color: vc }}>{vt}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* ── Right column ── */}
          <div className="gradepilot-right" style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%", overflow: "hidden" }}>

            {/* Target grade card */}
            <div className="gp-card target-card" style={{ background: "#fff", border: "1px solid #ebebeb", borderRadius: 14, overflow: "hidden", flexShrink: 0 }}>
              <div style={{ padding: "10px 18px 8px", borderBottom: "1px solid #f4f4f4", display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>Target Grade</div>
                <div style={{ fontSize: 10, color: course.gradeScale?.length ? ACCENT : "#aaa", fontWeight: course.gradeScale?.length ? 700 : 400 }}>
                  {course.gradeScale?.length ? `Syllabus scale · ${course.code}` : course.code}
                </div>
              </div>
              <div style={{ padding: "12px 18px 14px" }}>
                {/* Grade buttons */}
                <div className="target-grade-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 7, marginBottom: 12 }}>
                  {targetButtons.map((g) => {
                    const active = target === g;
                    return (
                      <button className={`target-grade-button${active ? " is-active" : ""}`} key={g} onClick={() => setTarget(g)}
                        style={{
                          padding: "8px 0", borderRadius: 9,
                          border: `2px solid ${active ? ACCENT : "#e8e8e8"}`,
                          background: active ? ACCENT : "#fff",
                          color: active ? "#fff" : "#aaa",
                          fontSize: 13, fontWeight: 800, fontFamily: "DM Mono, monospace",
                          cursor: "pointer", transition: "all 0.12s",
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
                        {Math.ceil(sharedNeeded)}
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
                  <div className="requirement-breakdown">
                    <div className="requirement-breakdown-heading">
                      <div>
                        <div className="requirement-breakdown-title">Shared minimum score</div>
                        <div className="requirement-breakdown-note">Earn at least this score on every pending assessment.</div>
                      </div>
                      <div className="requirement-target">{target} target</div>
                    </div>
                    {targetRequirements.map(({ component, needed }) => {
                      const status = needed > 100 ? "Not possible" : needed <= 0 ? "Any score" : `${Math.ceil(needed)} pts`;
                      return (
                        <div className="requirement-row" key={component.id}>
                          <div>
                            <div className="requirement-name">{component.name}</div>
                            <div className="requirement-weight">{component.weight}% of course grade</div>
                          </div>
                          <div className={`requirement-score${needed > 100 ? " is-impossible" : needed <= 0 ? " is-secured" : ""}`}>
                            {status}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Current projected */}
                {projGrade && projected !== null && (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, padding: "8px 12px", background: "#fafafa", borderRadius: 8, border: "1px solid #f0f0f0" }}>
                    <span style={{ fontSize: 11, color: "#888" }}>Current projected</span>
                    <span style={{ fontFamily: "DM Mono, monospace", fontSize: 16, fontWeight: 900, color: GRADE_COLORS[projGrade.label] ?? "#888" }}>
                      {projGrade.label} <span style={{ fontSize: 10, fontWeight: 400, color: "#bbb" }}>{projected.toFixed(1)}%</span>
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Semester GPA card */}
            <div className="gp-card gpa-card" style={{ background: "#fff", border: "1px solid #ebebeb", borderRadius: 14, padding: "12px 18px", flex: 1, minHeight: 0, overflow: "auto" }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#111" }}>Estimated Semester GPA</div>
                <div>
                  <span style={{ fontFamily: "DM Mono, monospace", fontSize: 22, fontWeight: 900, color: "#111", letterSpacing: "-0.02em" }}>{semGpa.toFixed(2)}</span>
                  <span style={{ fontFamily: "DM Mono, monospace", fontSize: 10, color: "#bbb" }}> / {semGpaMax.toFixed(1)}</span>
                </div>
              </div>
              {gpaItems.map(({ course: c, grade: g, pct, color }) => (
                <div key={c.id} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#333" }}>{c.code}</div>
                      <div style={{ fontSize: 10, color: "#bbb" }}>{c.name}</div>
                    </div>
                    <span style={{ fontFamily: "DM Mono, monospace", fontSize: 13, fontWeight: 800, color: GRADE_COLORS[g.label] ?? "#888" }}>{g.label}</span>
                  </div>
                  <div style={{ height: 4, background: "#f0f0f0", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: "100%", background: color, borderRadius: 2, transition: "width 0.4s ease" }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
