/**
 * Mentions in a message: `@path` points at a project file, `/name` asks for a skill, and the
 * commands /plan and /build pick the mode for that message. Shared by the composer (which
 * suggests them) and the run (which loads the files and skills into that turn's prompt).
 */

export const COMMANDS: Record<string, string> = {
  plan: "Plan first for this message (nothing is changed)",
  build: "Build this message straight away",
  review: "Review recent runs and suggest skills, rules or memories",
};

const FILE = /(^|\s)@([A-Za-z0-9_.\-/]*[A-Za-z0-9_\-/])/g;
const SLASH = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[\s.,!?;:])/g;

export interface Mentions {
  files: string[];
  skills: string[];
  commands: string[];
}

export function parseMentions(text: string): Mentions {
  const files = new Set<string>();
  const skills = new Set<string>();
  const commands = new Set<string>();
  for (const m of text.matchAll(FILE)) {
    const path = m[2].replace(/^\.\//, "");
    // A file path has a dot or a slash (so "@alice" isn't one), and never climbs out of the project.
    if ((path.includes(".") || path.includes("/")) && !path.split("/").includes("..")) files.add(path);
  }
  for (const m of text.matchAll(SLASH)) (m[2] in COMMANDS ? commands : skills).add(m[2]);
  return { files: [...files].slice(0, 8), skills: [...skills].slice(0, 5), commands: [...commands] };
}

/** The mention being typed at the caret, if any, for suggestions. */
export function activeToken(text: string, caret: number): { kind: "file" | "slash"; query: string; start: number } | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const token = text.slice(start, caret);
  if (token.startsWith("@")) return { kind: "file", query: token.slice(1), start };
  if (token.startsWith("/") && !token.slice(1).includes("/")) return { kind: "slash", query: token.slice(1), start };
  return null;
}

/** Replaces the token at [start, caret) with a mention and a trailing space. */
export function insertToken(text: string, start: number, caret: number, token: string): { text: string; caret: number } {
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end++;
  const next = `${text.slice(0, start)}${token} ${text.slice(end).replace(/^\s+/, "")}`;
  return { text: next, caret: start + token.length + 1 };
}

/** Ranks suggestions: prefix matches on the file name first, then anywhere in the path. */
export function rankFiles(files: string[], query: string, limit = 8): string[] {
  const q = query.toLowerCase();
  if (!q) return files.filter((f) => f.startsWith("src/")).slice(0, limit);
  const scored = files
    .map((f) => {
      const lower = f.toLowerCase();
      const name = lower.split("/").pop() ?? lower;
      const score = name.startsWith(q) ? 0 : lower.startsWith(q) ? 1 : name.includes(q) ? 2 : lower.includes(q) ? 3 : -1;
      return { f, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.f.length - b.f.length);
  return scored.slice(0, limit).map((x) => x.f);
}

/** Splits a message into plain text and the mentions parseMentions would act on, for display. */
export function splitMentions(text: string): Array<{ text: string; kind?: "file" | "skill" }> {
  const found = parseMentions(text);
  const out: Array<{ text: string; kind?: "file" | "skill" }> = [];
  let last = 0;
  for (const m of text.matchAll(/(^|\s)([@/][A-Za-z0-9_.\-/]+)/g)) {
    const token = m[2].replace(/[.,!?;:]+$/, "");
    const name = token.slice(1).replace(/^\.\//, "");
    const kind = token[0] === "@" ? (found.files.includes(name) ? "file" : undefined) : found.skills.includes(name) ? "skill" : undefined;
    if (!kind) continue;
    const at = (m.index ?? 0) + m[1].length;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ text: token, kind });
    last = at + token.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
