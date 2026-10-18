"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { ModelPicker } from "@/components/model-picker";
import { api } from "@/lib/client/api";
import { COMMANDS, activeToken, insertToken, rankFiles } from "@/lib/mentions";

export type RunMode = "plan" | "build";

type Suggestion = { value: string; label: string; hint?: string };
type CustomizeSection = "kits" | "connections" | "skills" | "rules" | "memory";

/**
 * The message box. Inside a project it also offers `@` to point at a file and `/` to use a skill
 * (or /plan, /build), plus a + menu for the same and for Customize. Mentions travel as plain
 * text; the run loads the files and skills they name into that turn.
 */
export function Composer(props: {
  value: string;
  onChange(v: string): void;
  onSubmit(): void;
  mode: RunMode;
  onModeChange(m: RunMode): void;
  running?: boolean;
  onStop?(): void;
  placeholder?: string;
  compact?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  label?: string;
  /** Enables @files, /skills and the + menu. */
  projectId?: string;
  onOpenCustomize?(section?: CustomizeSection): void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [suggest, setSuggest] = useState<{ kind: "file" | "slash"; query: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<string[] | null>(null);
  const [skills, setSkills] = useState<Array<{ name: string; description: string }> | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const loading = useRef({ files: false, skills: false });
  const plusRef = useRef<HTMLSpanElement>(null);
  // Where the caret goes once a picked suggestion is in the box: set right after React commits
  // the new value, before the next keystroke can land somewhere else.
  const caretAfter = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && caretAfter.current !== null) {
      el.setSelectionRange(caretAfter.current, caretAfter.current);
      caretAfter.current = null;
    }
  }, [props.value]);

  // The + menu closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!plusOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!plusRef.current?.contains(e.target as Node)) setPlusOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPlusOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [plusOpen]);

  useEffect(() => {
    if (props.autoFocus) ref.current?.focus();
  }, [props.autoFocus]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [props.value]);

  function load(kind: "file" | "slash") {
    const id = props.projectId;
    if (!id) return;
    if (kind === "file" && files === null && !loading.current.files) {
      loading.current.files = true;
      void api<{ files: string[] }>(`/api/projects/${id}/files`)
        .then((r) => setFiles(r.files))
        .catch(() => setFiles([]));
    }
    if (kind === "slash" && skills === null && !loading.current.skills) {
      loading.current.skills = true;
      void api<{ builtin: Array<{ name: string; description: string; enabled: boolean; overridden: boolean }>; project: Array<{ name: string; description: string }> }>(`/api/projects/${id}/skills`)
        .then((r) => setSkills([...r.project, ...r.builtin.filter((b) => b.enabled && !b.overridden)]))
        .catch(() => setSkills([]));
    }
  }

  function track(text: string, caret: number) {
    if (!props.projectId) return;
    const t = activeToken(text, caret);
    setSuggest(t);
    setActive(0);
    if (t) load(t.kind);
  }

  const items: Suggestion[] = !suggest
    ? []
    : suggest.kind === "file"
      ? rankFiles(files ?? [], suggest.query).map((f) => ({ value: `@${f}`, label: f }))
      : [
          ...Object.entries(COMMANDS).map(([name, hint]) => ({ value: `/${name}`, label: `/${name}`, hint })),
          ...(skills ?? []).map((s) => ({ value: `/${s.name}`, label: `/${s.name}`, hint: s.description })),
        ]
          .filter((s) => s.label.slice(1).startsWith(suggest.query.toLowerCase()) || s.label.includes(suggest.query.toLowerCase()))
          .slice(0, 8);
  const open = Boolean(suggest) && (items.length > 0 || (suggest?.kind === "file" ? files === null : skills === null));

  function pick(s: Suggestion) {
    const el = ref.current;
    if (!el || !suggest) return;
    const r = insertToken(props.value, suggest.start, el.selectionStart ?? props.value.length, s.value);
    caretAfter.current = r.caret;
    props.onChange(r.text);
    setSuggest(null);
    el.focus();
  }

  /** From the + menu: start a mention at the caret and open its suggestions. */
  function startMention(char: "@" | "/") {
    const el = ref.current;
    setPlusOpen(false);
    if (!el) return;
    const caret = el.selectionStart ?? props.value.length;
    const before = props.value.slice(0, caret);
    const pad = before && !/\s$/.test(before) ? " " : "";
    const text = `${before}${pad}${char}${props.value.slice(caret)}`;
    const at = caret + pad.length + 1;
    caretAfter.current = at;
    props.onChange(text);
    el.focus();
    track(text, at);
  }

  const canSend = props.value.trim().length > 0 && !props.disabled && !props.running;
  const listId = "composer-suggest";
  return (
    <form
      className={`composer${props.compact ? " compact" : ""}`}
      style={{ position: "relative" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) props.onSubmit();
      }}
    >
      <label className="sr-only" htmlFor="composer-input">
        {props.label ?? "Describe what you want to build"}
      </label>
      {open && (
        <div className="suggest" role="listbox" id={listId} aria-label={suggest?.kind === "file" ? "Project files" : "Skills and commands"}>
          {items.length === 0 ? (
            <div className="suggest-empty"><span className="spin" /> Loading…</div>
          ) : (
            items.map((s, i) => (
              <div
                key={s.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className="suggest-opt"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="mono">{s.label}</span>
                {s.hint && <span className="muted suggest-hint">{s.hint}</span>}
              </div>
            ))
          )}
        </div>
      )}
      <textarea
        id="composer-input"
        ref={ref}
        rows={props.compact ? 2 : 3}
        value={props.value}
        placeholder={props.placeholder ?? "Describe what you want to build…"}
        role={props.projectId ? "combobox" : undefined}
        aria-autocomplete={props.projectId ? "list" : undefined}
        aria-expanded={props.projectId ? open : undefined}
        aria-controls={props.projectId && open ? listId : undefined}
        aria-activedescendant={open && items.length ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          props.onChange(e.target.value);
          track(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onBlur={() => setTimeout(() => setSuggest(null), 120)}
        onKeyDown={(e) => {
          if (open && items.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pick(items[active]);
              return;
            }
          }
          if (open && e.key === "Escape") {
            e.preventDefault();
            setSuggest(null);
            return;
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend) props.onSubmit();
          }
        }}
        disabled={props.disabled}
      />
      <div className="composer-row">
        {props.projectId && (
          <span ref={plusRef} style={{ position: "relative" }}>
            <button
              type="button"
              className="iconbtn"
              aria-label="Add a file, skill or connection"
              title="Mention a file, use a skill, or manage connections and rules"
              aria-expanded={plusOpen}
              onClick={() => setPlusOpen((o) => !o)}
            >
              <Icon name="plus" size={16} />
            </button>
            {plusOpen && (
              <div className="pop plus-pop" role="group" aria-label="Add">
                <button type="button" className="opt" onClick={() => startMention("@")}>
                  <Icon name="file" size={15} /> <span><b>Mention a file</b><span className="muted"> · type @</span></span>
                </button>
                <button type="button" className="opt" onClick={() => startMention("/")}>
                  <Icon name="sparkle" size={15} /> <span><b>Use a skill</b><span className="muted"> · type /</span></span>
                </button>
                <button type="button" className="opt" onClick={() => { setPlusOpen(false); props.onOpenCustomize?.("connections"); }}>
                  <Icon name="globe" size={15} /> <span><b>Connections</b><span className="muted"> · MCP servers</span></span>
                </button>
                <button type="button" className="opt" onClick={() => { setPlusOpen(false); props.onOpenCustomize?.("rules"); }}>
                  <Icon name="shield" size={15} /> <span><b>Rules that always run</b></span>
                </button>
                <button type="button" className="opt" onClick={() => { setPlusOpen(false); props.onOpenCustomize?.(); }}>
                  <Icon name="gear" size={15} /> <span><b>Customize…</b></span>
                </button>
              </div>
            )}
          </span>
        )}
        <div className="mode" role="group" aria-label="Run mode">
          <button type="button" aria-pressed={props.mode === "plan"} onClick={() => props.onModeChange("plan")} title="Agree on a plan before anything is built">
            Plan first
          </button>
          <button type="button" aria-pressed={props.mode === "build"} onClick={() => props.onModeChange("build")} title="Start building straight away">
            Build
          </button>
        </div>
        <ModelPicker compact={props.compact} />
        <span className="spacer" />
        {props.running ? (
          <button type="button" className="send stop" onClick={props.onStop} aria-label="Stop the run" title="Stop">
            <Icon name="stop" size={16} />
          </button>
        ) : (
          <button type="submit" className="send" disabled={!canSend} aria-label="Send" title="Send (Enter)">
            <Icon name="arrowup" size={18} />
          </button>
        )}
      </div>
    </form>
  );
}
