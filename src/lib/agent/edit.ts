/**
 * Find-and-replace for the edit_file tool, tolerant of the ways models misquote code.
 *
 * Tiers, tried in order; the first tier with any match wins:
 *   1. exact        – byte-for-byte on the LF view of the file
 *   2. unicode      – typographic quotes, dashes and odd spaces folded to ASCII
 *   3. trim-end     – line by line, ignoring trailing whitespace
 *   4. indentation  – line by line, ignoring a consistent leading-indent offset; the
 *                     replacement is re-indented to the file's actual indentation
 * A match must be unique unless replaceAll is set. CRLF files keep their line endings.
 *
 * Tiers 1–3 follow OpenCode's edit tool (MIT); tier 4 is ours, for models that re-indent
 * snippets when quoting them.
 */

export type EditTier = "exact" | "unicode" | "trim-end" | "indentation";

export interface EditResult {
  ok: true;
  content: string;
  replacements: number;
  tier: EditTier;
}
export interface EditFailure {
  ok: false;
  error: string;
}

interface Span {
  start: number;
  end: number;
  /** Indentation delta to apply to the replacement (tier 4 only). */
  reindent?: { from: string; to: string };
}

const normalize = (s: string) =>
  s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[  -   　]/g, " ");

function findAll(haystack: string, needle: string): Span[] {
  const out: Span[] = [];
  if (!needle) return out;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    out.push({ start: i, end: i + needle.length });
    i += needle.length;
  }
  return out;
}

interface Line {
  start: number;
  end: number; // exclusive, excluding the newline
  text: string;
}

function splitLines(s: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i <= s.length; i++) {
    if (i === s.length || s[i] === "\n") {
      lines.push({ start, end: i, text: s.slice(start, i) });
      start = i + 1;
    }
  }
  return lines;
}

function leadingWs(s: string) {
  return s.match(/^[ \t]*/)?.[0] ?? "";
}

function lineMatches(content: string, search: string, mode: "trim-end" | "indentation"): Span[] {
  const hadTrailingNewline = search.endsWith("\n");
  const wanted = (hadTrailingNewline ? search.slice(0, -1) : search).split("\n");
  // Ignore blank leading/trailing lines in the search block.
  while (wanted.length > 1 && wanted[0].trim() === "") wanted.shift();
  while (wanted.length > 1 && wanted[wanted.length - 1].trim() === "") wanted.pop();
  if (wanted.length === 0 || wanted.every((l) => l.trim() === "")) return [];
  const lines = splitLines(content);
  const out: Span[] = [];
  const firstNonBlank = wanted.find((l) => l.trim() !== "") ?? "";
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    const window = lines.slice(i, i + wanted.length);
    let reindent: Span["reindent"];
    let ok = true;
    if (mode === "trim-end") {
      ok = window.every((l, k) => normalize(l.text.trimEnd()) === normalize(wanted[k].trimEnd()));
    } else {
      const anchor = window[wanted.indexOf(firstNonBlank)];
      const from = leadingWs(firstNonBlank);
      const to = leadingWs(anchor.text);
      ok = window.every((l, k) => {
        const w = wanted[k];
        if (w.trim() === "") return l.text.trim() === "";
        const wIndent = leadingWs(w);
        if (!wIndent.startsWith(from) && from.length > 0 && !from.startsWith(wIndent)) return false;
        const rel = wIndent.slice(Math.min(from.length, wIndent.length));
        const lIndent = leadingWs(l.text);
        return lIndent === to + rel && normalize(l.text.trim()) === normalize(w.trim());
      });
      if (ok && from !== to) reindent = { from, to };
    }
    if (!ok) continue;
    const last = window[window.length - 1];
    const end = hadTrailingNewline && last.end < content.length ? last.end + 1 : last.end;
    const span: Span = { start: window[0].start, end, reindent };
    if (!out.some((m) => m.end > span.start && m.start < span.end)) out.push(span);
  }
  return out;
}

function reindentBlock(text: string, r: NonNullable<Span["reindent"]>): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      if (r.from && line.startsWith(r.from)) return r.to + line.slice(r.from.length);
      if (!r.from) return r.to + line;
      return line;
    })
    .join("\n");
}

export function applyEdit(original: string, oldString: string, newString: string, replaceAll = false): EditResult | EditFailure {
  if (oldString === "") return { ok: false, error: "old_string must not be empty. Use write_file to create or overwrite a file." };
  if (oldString === newString) return { ok: false, error: "old_string and new_string are identical; nothing to change." };

  const crlf = original.includes("\r\n");
  const view = crlf ? original.replace(/\r\n/g, "\n") : original;
  const search = oldString.replace(/\r\n/g, "\n");
  const replacement = newString.replace(/\r\n/g, "\n");

  let tier: EditTier = "exact";
  let spans = findAll(view, search);
  if (spans.length === 0) {
    tier = "unicode";
    spans = findAll(normalize(view), normalize(search));
  }
  if (spans.length === 0) {
    tier = "trim-end";
    spans = lineMatches(view, search, "trim-end");
  }
  if (spans.length === 0) {
    tier = "indentation";
    spans = lineMatches(view, search, "indentation");
  }

  if (spans.length === 0) {
    return {
      ok: false,
      error:
        "old_string was not found in the file. It must match the current file text (indentation and line breaks included). Re-read the file with read_file and copy the exact lines, without the line-number prefixes.",
    };
  }
  if (spans.length > 1 && !replaceAll) {
    return {
      ok: false,
      error: `old_string matches ${spans.length} places. Include more surrounding lines so it matches exactly one, or set replace_all to true to change every occurrence.`,
    };
  }

  const chosen = replaceAll ? spans : spans.slice(0, 1);
  let out = view;
  for (const span of [...chosen].reverse()) {
    let rep = span.reindent ? reindentBlock(replacement, span.reindent) : replacement;
    // Line-based tiers matched whole lines; keep the trailing newline consistent.
    if (tier === "trim-end" || tier === "indentation") {
      const matched = out.slice(span.start, span.end);
      if (matched.endsWith("\n") && !rep.endsWith("\n")) rep += "\n";
    }
    out = out.slice(0, span.start) + rep + out.slice(span.end);
  }
  if (out === view) return { ok: false, error: "The edit leaves the file unchanged." };
  return { ok: true, content: crlf ? out.replace(/\n/g, "\r\n") : out, replacements: chosen.length, tier };
}

/**
 * Line diff for the UI and the model: LCS over the changed middle of the file (common prefix
 * and suffix trimmed first), rendered as hunks with `context` lines around each change.
 */
export function miniDiff(before: string, after: string, context = 2, maxLines = 120): { diff: string; added: number; removed: number } {
  const a = before.split("\n");
  const b = after.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  type Op = { t: " " | "-" | "+"; line: string; ai: number };
  const ops: Op[] = [];
  if (am.length * bm.length <= 4_000_000) {
    const w = bm.length + 1;
    const dp = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--)
      for (let j = bm.length - 1; j >= 0; j--)
        dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) {
        ops.push({ t: " ", line: am[i++], ai: pre + i - 1 });
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push({ t: "-", line: am[i++], ai: pre + i - 1 });
      else ops.push({ t: "+", line: bm[j++], ai: pre + i });
    }
    while (i < am.length) ops.push({ t: "-", line: am[i++], ai: pre + i - 1 });
    while (j < bm.length) ops.push({ t: "+", line: bm[j++], ai: pre + i });
  } else {
    am.forEach((line, k) => ops.push({ t: "-", line, ai: pre + k }));
    bm.forEach((line) => ops.push({ t: "+", line, ai: pre + am.length }));
  }

  const full: Op[] = [
    ...a.slice(0, pre).map((line, k) => ({ t: " " as const, line, ai: k })),
    ...ops,
    ...a.slice(a.length - suf).map((line, k) => ({ t: " " as const, line, ai: a.length - suf + k })),
  ];
  const changed = full.map((o, k) => (o.t !== " " ? k : -1)).filter((k) => k >= 0);
  const keep = new Set<number>();
  for (const k of changed) for (let d = -context; d <= context; d++) if (k + d >= 0 && k + d < full.length) keep.add(k + d);
  const out: string[] = [];
  let last = -2;
  for (let k = 0; k < full.length; k++) {
    if (!keep.has(k)) continue;
    if (k !== last + 1) out.push(`@@ line ${full[k].ai + 1} @@`);
    out.push(`${full[k].t} ${full[k].line}`);
    last = k;
  }
  const added = ops.filter((o) => o.t === "+").length;
  const removed = ops.filter((o) => o.t === "-").length;
  const lines = out.length > maxLines ? [...out.slice(0, maxLines), `… ${out.length - maxLines} more diff lines`] : out;
  return { diff: lines.join("\n"), added, removed };
}
