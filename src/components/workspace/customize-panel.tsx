"use client";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { ApiError, api } from "@/lib/client/api";

type Section = "skills";

const SECTIONS: Array<[Section, string]> = [["skills", "Skills"]];

/**
 * Customize: how Daedalus works on this project. Everything here is a standard, portable
 * format (SKILL.md files in the repo, AGENTS.md, MCP servers), so nothing is locked in.
 */
export function CustomizePanel({ projectId, hasSandbox, refreshKey }: { projectId: string; hasSandbox: boolean; refreshKey: number }) {
  const [section, setSection] = useState<Section>("skills");
  return (
    <div className="agents">
      <div className="mode" role="group" aria-label="Customize sections" style={{ justifySelf: "start" }}>
        {SECTIONS.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={section === id} onClick={() => setSection(id)}>
            {label}
          </button>
        ))}
      </div>
      {section === "skills" && <SkillsSection projectId={projectId} hasSandbox={hasSandbox} refreshKey={refreshKey} />}
    </div>
  );
}

interface SkillsInfo {
  builtin: Array<{ name: string; description: string; enabled: boolean; overridden: boolean }>;
  project: Array<{ name: string; description: string; path?: string }>;
  hasSandbox: boolean;
}

const EMPTY_FORM = { name: "", description: "", body: "" };

function SkillsSection({ projectId, hasSandbox, refreshKey }: { projectId: string; hasSandbox: boolean; refreshKey: number }) {
  const [info, setInfo] = useState<SkillsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, string>>({});
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api<SkillsInfo>(`/api/projects/${projectId}/skills`)
      .then((r) => !cancelled && setInfo(r))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : "Couldn't load skills"));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey, reload]);

  const view = useCallback(
    async (name: string) => {
      if (open[name] !== undefined) {
        setOpen((o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== name)));
        return;
      }
      const r = await api<{ content: string }>(`/api/projects/${projectId}/skills?name=${encodeURIComponent(name)}`).catch(() => null);
      setOpen((o) => ({ ...o, [name]: r?.content ?? "Couldn't load this skill." }));
    },
    [open, projectId],
  );

  async function edit(name: string) {
    const r = await api<{ name: string; description: string; body: string }>(`/api/projects/${projectId}/skills?name=${encodeURIComponent(name)}`).catch(() => null);
    if (!r) return;
    setForm({ name: r.name, description: r.description, body: r.body });
    setEditing(name);
    setFormError(null);
    document.getElementById("skill-name")?.focus();
  }

  async function save() {
    setSaving(true);
    setFormError(null);
    try {
      await api(`/api/projects/${projectId}/skills`, { method: "POST", json: form });
      setForm(EMPTY_FORM);
      setEditing(null);
      setOpen({});
      setReload((n) => n + 1);
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : "Couldn't save the skill");
    } finally {
      setSaving(false);
    }
  }

  async function remove(name: string) {
    setConfirmDelete(null);
    await api(`/api/projects/${projectId}/skills?name=${encodeURIComponent(name)}`, { method: "DELETE" }).catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't delete"));
    setReload((n) => n + 1);
  }

  async function toggle(name: string, enabled: boolean) {
    setInfo((i) => (i ? { ...i, builtin: i.builtin.map((b) => (b.name === name ? { ...b, enabled } : b)) } : i));
    await api(`/api/projects/${projectId}/skills`, { method: "PATCH", json: { name, enabled } }).catch(() => setReload((n) => n + 1));
  }

  if (error) return <div className="error-text">{error}</div>;
  if (!info) return <span className="spin" />;

  return (
    <>
      <section aria-labelledby="skills-h" className="agents-sec">
        <h2 id="skills-h" className="label">Skills</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Playbooks for how a kind of work should be done. Daedalus sees each skill&apos;s name and description, and loads the full instructions when a
          task matches. Your skills are <span className="mono">SKILL.md</span> files in the project (<span className="mono">.agents/skills/</span>), so other
          agent tools can use them too.
        </p>
        <div className="agent-cards">
          {info.project.map((s) => (
            <article key={s.name} className="agent-card">
              <div className="agent-h">
                <span className="agent-ic"><Icon name="file" /></span>
                <div style={{ minWidth: 0 }}>
                  <b className="mono">{s.name}</b>
                  <div className="muted" style={{ fontSize: 13 }}>{s.description}</div>
                </div>
              </div>
              {open[s.name] !== undefined && <pre className="codeblock">{open[s.name]}</pre>}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="btn sm" aria-expanded={open[s.name] !== undefined} onClick={() => void view(s.name)}>
                  {open[s.name] !== undefined ? "Hide" : "View"}
                </button>
                <button className="btn sm" onClick={() => void edit(s.name)}>Edit</button>
                {confirmDelete === s.name ? (
                  <>
                    <button className="btn sm danger" onClick={() => void remove(s.name)}>Delete {s.name}</button>
                    <button className="btn sm ghost" onClick={() => setConfirmDelete(null)}>Keep</button>
                  </>
                ) : (
                  <button className="btn sm ghost" onClick={() => setConfirmDelete(s.name)}>Delete</button>
                )}
              </div>
            </article>
          ))}
          {info.project.length === 0 && <p className="hint" style={{ margin: 0 }}>No project skills yet. Add one below, or let Daedalus use the built-in ones.</p>}
        </div>
      </section>

      <section aria-labelledby="skill-form-h" className="agents-sec">
        <h2 id="skill-form-h" className="label">{editing ? `Edit ${editing}` : "New skill"}</h2>
        {!hasSandbox ? (
          <p className="hint">Available once the project has started.</p>
        ) : (
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <label className="field">
              <span>Name</span>
              <input id="skill-name" className="input mono" placeholder="brand-voice" value={form.name} readOnly={Boolean(editing)} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} />
              <span className="hint">Lowercase words joined by hyphens.</span>
            </label>
            <label className="field">
              <span>When to use it</span>
              <input className="input" placeholder="Write copy the way our brand talks. Use for any customer-facing text." value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              <span className="hint">Daedalus decides from this line whether the skill applies, so say what it does and when.</span>
            </label>
            <label className="field">
              <span>Instructions</span>
              <textarea className="input mono" style={{ minHeight: 180, fontSize: 13, lineHeight: 1.5 }} placeholder={"- Warm and short: two paragraphs at most.\n- No jargon, no exclamation marks.\n- Sign off as \"The Acme team\"."} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn primary" disabled={saving || !form.name || !form.description || !form.body} onClick={() => void save()}>
                {saving && <span className="spin" />} {editing ? "Save changes" : "Add skill"}
              </button>
              {editing && (
                <button className="btn ghost" onClick={() => { setEditing(null); setForm(EMPTY_FORM); }}>Cancel</button>
              )}
              {formError && <span className="error-text" role="alert">{formError}</span>}
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="builtin-h" className="agents-sec">
        <h2 id="builtin-h" className="label">Built-in skills</h2>
        <div className="agent-cards">
          {info.builtin.map((s) => (
            <article key={s.name} className="agent-card">
              <div className="agent-h">
                <span className="agent-ic sub"><Icon name="sparkle" /></span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <b className="mono">{s.name}</b>
                  <div className="muted" style={{ fontSize: 13 }}>{s.description}</div>
                  {s.overridden && <div className="hint">Your project has its own {s.name} skill, which is used instead.</div>}
                </div>
              </div>
              {open[s.name] !== undefined && <pre className="codeblock">{open[s.name]}</pre>}
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 14 }}>
                  <input type="checkbox" checked={s.enabled} onChange={(e) => void toggle(s.name, e.target.checked)} /> On for this project
                </label>
                <button className="btn sm ghost" aria-expanded={open[s.name] !== undefined} onClick={() => void view(s.name)}>
                  {open[s.name] !== undefined ? "Hide" : "View"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
