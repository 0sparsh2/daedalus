"use client";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { ApiError, api } from "@/lib/client/api";

/** Read-only code browser over the sandbox's files. */
export function CodePanel({ projectId, refreshKey, hasSandbox }: { projectId: string; refreshKey: number; hasSandbox: boolean }) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<{ path: string; key: number; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasSandbox) return;
    let cancelled = false;
    api<{ files: string[] }>(`/api/projects/${projectId}/files`)
      .then((r) => {
        if (cancelled) return;
        setFiles(r.files);
        setSelected((s) => s ?? (r.files.includes("src/App.tsx") ? "src/App.tsx" : (r.files[0] ?? null)));
      })
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : "Couldn't list files"));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey, hasSandbox]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    api<{ content?: string; binary?: boolean }>(`/api/projects/${projectId}/file?path=${encodeURIComponent(selected)}`)
      .then((r) => !cancelled && setFile({ path: selected, key: refreshKey, content: r.binary ? "(binary file)" : (r.content ?? "") }))
      .catch((e) => !cancelled && setFile({ path: selected, key: refreshKey, content: e instanceof ApiError ? `// ${e.message}` : "// Couldn't read the file" }));
    return () => {
      cancelled = true;
    };
  }, [projectId, selected, refreshKey]);
  const loadingFile = Boolean(selected) && (file?.path !== selected || file?.key !== refreshKey);
  const content = file?.path === selected ? file.content : null;

  const tree = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const f of files ?? []) {
      const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
      groups.set(dir, [...(groups.get(dir) ?? []), f]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files]);

  if (!hasSandbox) {
    return (
      <div className="empty">
        <Icon name="code" size={22} />
        <b>No code yet</b>
        <span>Files appear here once Daedalus starts building.</span>
      </div>
    );
  }
  if (error) return <div className="empty"><div className="error-text">{error}</div></div>;
  if (!files) return <div className="empty"><span className="spin" /></div>;

  return (
    <div className="code">
      <nav className="filetree" aria-label="Project files">
        {tree.map(([dir, list]) => (
          <div key={dir || "."}>
            {dir && <div className="dir mono">{dir}/</div>}
            {list.map((f) => (
              <button key={f} aria-current={selected === f} onClick={() => setSelected(f)} style={{ paddingLeft: dir ? 18 : 8 }}>
                <Icon name="file" size={13} /> {f.split("/").pop()}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="viewer" aria-label={selected ?? "File"} aria-busy={loadingFile}>
        {selected && (
          <div className="urlbar" style={{ position: "sticky", top: 0 }}>
            <span className="url">{selected}</span>
          </div>
        )}
        <pre>
          {(content ?? "").split("\n").map((l, i) => (
            <span key={i} className="ln">
              {l || " "}
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}
