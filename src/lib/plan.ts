/**
 * A proposed plan as the UI shows it. Plan parts come straight from model output: while the
 * call streams, or when a model sends a list as a JSON string or bullet text, fields can have
 * any shape. Rendering always goes through normalizePlan, never the raw input.
 */
export interface Plan {
  title: string;
  summary: string;
  features: string[];
  design: string;
  steps: string[];
  assumptions: string[];
  questions: string[];
}

const text = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const named = o.title ?? o.name ?? o.text ?? o.description ?? o.step;
    if (typeof named === "string") return named;
    return JSON.stringify(v);
  }
  return "";
};

/** Any list-ish value as clean strings: arrays, JSON-encoded arrays, or bullet/numbered text. */
export function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(text).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(s);
        if (Array.isArray(parsed)) return asList(parsed);
      } catch {
        // partial or invalid JSON: fall through to line splitting
      }
    }
    return s
      .split(/\n+/)
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
      .filter(Boolean);
  }
  return [];
}

export function normalizePlan(input: unknown): Plan {
  const p = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    title: text(p.title).trim(),
    summary: text(p.summary).trim(),
    features: asList(p.features),
    design: text(p.design).trim(),
    steps: asList(p.steps),
    assumptions: asList(p.assumptions),
    questions: asList(p.questions),
  };
}

export interface Question {
  question: string;
  options: string[];
}

/** ask_user input as the UI shows it, whatever shape the model sent. */
export function normalizeQuestions(input: unknown): Question[] {
  const raw = input && typeof input === "object" ? (input as { questions?: unknown }).questions : undefined;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? asList(raw).map((q) => ({ question: q })) : [];
  return list
    .map((q) => {
      if (typeof q === "string") return { question: q.trim(), options: [] };
      const o = (q && typeof q === "object" ? q : {}) as Record<string, unknown>;
      return { question: text(o.question ?? o.text).trim(), options: asList(o.options).slice(0, 6) };
    })
    .filter((q) => q.question);
}

