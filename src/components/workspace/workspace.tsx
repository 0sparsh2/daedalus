"use client";
import { useChat } from "@ai-sdk/react";
import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseMentions } from "@/lib/mentions";
import { Composer, type RunMode } from "@/components/composer";
import { Brand, Icon } from "@/components/icons";
import { UserMenu } from "@/components/user-menu";
import { ApiError, api, toApiError } from "@/lib/client/api";
import { useSession } from "@/lib/client/session";
import { AgentsPanel } from "./agents-panel";
import { CHAT_DEFAULT, ChatResizer, clampChatWidth } from "./chat-resizer";
import { CodePanel } from "./code-panel";
import { Messages } from "./messages";
import { PlanPanel } from "./plan-panel";
import { CustomizePanel, type Section as CustomizeSection } from "./customize-panel";
import { PreviewPanel, type PreviewError, type SelectedElement } from "./preview-panel";
import { ShipMenu } from "./ship-menu";
import { TracePanel } from "./trace-panel";
import { VersionsMenu, type Checkpoint } from "./versions-menu";

export interface WorkspaceProject {
  id: string;
  name: string;
  previewUrl: string | null;
  status: string;
  githubRepo: string | null;
  deployUrl: string | null;
}

type Tab = "preview" | "code" | "trace" | "plan" | "agents" | "customize";

/**
 * Per-project chat runtime that lives outside React: the transport's callbacks read the
 * current mode and the in-flight workflow run id from here when a request is made.
 */
type Intent = "build" | "answer" | "review";
const runtimes = new Map<string, { mode: RunMode; workflowRunId: string | null; intent?: Intent }>();
const REVIEW_MESSAGE = "Review my recent runs and suggest how you could work better on this project.";
function runtimeFor(projectId: string) {
  let r = runtimes.get(projectId);
  if (!r) {
    r = { mode: "build", workflowRunId: null };
    runtimes.set(projectId, r);
  }
  return r;
}

function createTransport(projectId: string, hooks: { onRun(runId: string): void; onEnd(): void }) {
  const rt = runtimeFor(projectId);
  return new WorkflowChatTransport<UIMessage>({
    api: "/api/chat",
    maxConsecutiveErrors: 6,
    fetch: async (input, init) => {
      const res = await fetch(input, init);
      if (!res.ok) throw await toApiError(res);
      return res;
    },
    prepareSendMessagesRequest: ({ messages }) => {
      // The intent (an explicit action like "Start building") applies to this one message only.
      const body = { projectId, message: messages[messages.length - 1], mode: rt.mode, intent: rt.intent };
      rt.intent = undefined;
      return { body };
    },
    prepareReconnectToStreamRequest: ({ api: defaultApi }) => ({
      api: rt.workflowRunId ? `/api/chat/${encodeURIComponent(rt.workflowRunId)}/stream` : defaultApi,
    }),
    onChatSendMessage: (res) => {
      rt.workflowRunId = res.headers.get("x-workflow-run-id");
      const id = res.headers.get("x-daedalus-run-id");
      if (id) hooks.onRun(id);
    },
    onChatEnd: () => hooks.onEnd(),
  });
}

export function Workspace({
  project,
  initialMessages,
  activeRun,
  initialCheckpoints,
  initialMode,
}: {
  project: WorkspaceProject;
  initialMessages: UIMessage[];
  activeRun: { id: string; workflowRunId: string | null; mode: string } | null;
  initialCheckpoints: Checkpoint[];
  initialMode?: RunMode;
}) {
  const { ensureReady, openKeys } = useSession();
  const [name, setName] = useState(project.name);
  const [previewUrl, setPreviewUrl] = useState(project.previewUrl);
  const [previewNonce, setPreviewNonce] = useState(0);
  // Set when the agent's preview check asks for a fresh load of the open preview.
  const [checkId, setCheckId] = useState<string | undefined>();
  const [tab, setTab] = useState<Tab>("preview");
  // Which Customize section to open on, when the composer's + menu points at one.
  const [customizeAt, setCustomizeAt] = useState<{ section?: CustomizeSection; n: number }>({ n: 0 });
  const [view, setView] = useState<"chat" | "panel">("chat");
  // Desktop layout, remembered per browser: the chat's width (the divider) and full-screen chat.
  const [chatWidth, setChatWidth] = useState(CHAT_DEFAULT);
  const [chatOnly, setChatOnlyState] = useState(false);
  const [resizing, setResizing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      const w = Number(localStorage.getItem("daedalus:chat-width"));
      if (w) setChatWidth(clampChatWidth(w, bodyRef.current?.clientWidth ?? window.innerWidth));
      setChatOnlyState(localStorage.getItem("daedalus:chat-only") === "1");
    } catch {
      // storage unavailable: keep the defaults
    }
  }, []);
  const setChatOnly = useCallback((on: boolean) => {
    setChatOnlyState(on);
    try {
      localStorage.setItem("daedalus:chat-only", on ? "1" : "0");
    } catch {}
  }, []);
  const saveChatWidth = useCallback((w: number) => {
    setChatWidth(w);
    try {
      localStorage.setItem("daedalus:chat-width", String(w));
    } catch {}
  }, []);
  // ⌘\ or Ctrl+\ switches full-screen chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setChatOnly(!chatOnly);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatOnly, setChatOnly]);
  const [mode, setMode] = useState<RunMode>(initialMode ?? (initialMessages.length === 0 ? "plan" : "build"));
  const [runMode, setRunMode] = useState<RunMode>((activeRun?.mode as RunMode | undefined) ?? initialMode ?? "build");
  const [input, setInput] = useState("");
  const [runId, setRunId] = useState<string | null>(activeRun?.id ?? null);
  const [traceRunId, setTraceRunId] = useState<string | null>(activeRun?.id ?? null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>(initialCheckpoints);
  const [refreshKey, setRefreshKey] = useState(0);
  const [banner, setBanner] = useState<{ kind: "error" | "info"; text: string; action?: { label: string; run(): void } } | null>(null);
  const [stopping, setStopping] = useState(false);

  const refreshProject = useCallback(async () => {
    try {
      const r = await api<{ project: { name: string; preview_url: string | null }; checkpoints: Checkpoint[] }>(`/api/projects/${project.id}`);
      setName(r.project.name);
      if (r.project.preview_url) setPreviewUrl(r.project.preview_url);
      setCheckpoints(r.checkpoints);
    } catch {
      // keep current state
    }
  }, [project.id]);

  const transport = useMemo(
    () =>
      createTransport(project.id, {
        onRun: (id) => {
          setRunId(id);
          setTraceRunId(id);
        },
        onEnd: () => {
          setRunId(null);
          setStopping(false);
          void refreshProject();
          setRefreshKey((k) => k + 1);
        },
      }),
    [project.id, refreshProject],
  );

  const { messages, sendMessage, status, error, resumeStream, clearError } = useChat({
    id: project.id,
    messages: initialMessages,
    transport,
    onData: (part) => {
      if (part.type === "data-preview") {
        const url = (part.data as { url?: string })?.url;
        if (url) setPreviewUrl(url);
      }
      if (part.type === "data-checkpoint") {
        setPreviewNonce((n) => n + 1);
      }
      if (part.type === "data-preview-reload") {
        const id = (part.data as { checkId?: string })?.checkId;
        if (id) setCheckId(id);
      }
    },
    onError: (err) => {
      setRunId(null);
      setStopping(false);
      if (err instanceof ApiError && err.code === "needs_key") {
        setBanner({ kind: "error", text: err.message, action: { label: "Add key", run: () => void openKeys(err.data.provider as never) } });
      } else if (err instanceof ApiError && err.code === "run_in_progress") {
        setBanner({ kind: "info", text: "A run is already in progress. Reconnecting to it…" });
        const rt = runtimeFor(project.id);
        rt.workflowRunId = (err.data.workflowRunId as string) ?? rt.workflowRunId;
        void resumeStream();
      } else {
        setBanner({ kind: "error", text: err.message || "Something went wrong." });
      }
    },
  });

  const running = status === "submitted" || status === "streaming" || Boolean(runId);

  // Reconnect to a run that was in flight when the page loaded, or send the first message
  // handed over from the home page. Deferred one tick: useChat stops its chat on unmount, and
  // React's development double-mount would otherwise abort the request we just started.
  const started = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (started.current) return;
      started.current = true;
      const rt = runtimeFor(project.id);
      if (activeRun?.workflowRunId) {
        rt.workflowRunId = activeRun.workflowRunId;
        void resumeStream();
        return;
      }
      const key = `daedalus:autostart:${project.id}`;
      const raw = sessionStorage.getItem(key);
      if (!raw) return;
      sessionStorage.removeItem(key);
      try {
        const { text } = JSON.parse(raw) as { text: string };
        rt.mode = initialMode ?? "plan";
        void sendMessage({ text });
      } catch {}
    }, 0);
    return () => clearTimeout(timer);
  }, [activeRun, project.id, resumeStream, sendMessage, initialMode]);

  const send = useCallback(
    async (text: string, overrideMode?: RunMode, intent?: Intent) => {
      // /plan and /build pick the mode for this message, and /review asks for a review of recent
      // runs; the command itself isn't sent.
      const { commands } = parseMentions(text);
      const review = commands.includes("review");
      const command = commands.includes("build") ? "build" : commands.includes("plan") ? "plan" : undefined;
      let t = (command || review ? text.replace(/(^|\s)\/(plan|build|review)(?=$|[\s.,!?;:])/g, "$1") : text).trim();
      if (review) {
        intent = "review";
        t ||= REVIEW_MESSAGE;
      } else if (command && !overrideMode) {
        overrideMode = command;
        if (command === "build") intent ??= "build";
      }
      if (!t) {
        if (command) setMode(command);
        setInput("");
        return;
      }
      if (running) return;
      if (!(await ensureReady({ reason: "Connect a model to keep building." }))) return;
      const useMode = overrideMode ?? mode;
      if (overrideMode) setMode(overrideMode);
      runtimeFor(project.id).mode = useMode;
      runtimeFor(project.id).intent = intent;
      setRunMode(useMode);
      setBanner(null);
      clearError();
      setInput("");
      await sendMessage({ text: t });
    },
    [running, ensureReady, clearError, sendMessage, mode, project.id],
  );

  const stop = useCallback(async () => {
    if (!runId) return;
    setStopping(true);
    await api(`/api/runs/${runId}/stop`, { method: "POST" }).catch(() => setStopping(false));
  }, [runId]);

  const onPreviewError = useCallback(
    (e: PreviewError) => {
      if (running) return;
      setBanner({
        kind: "error",
        text: `The preview hit an error: ${e.message.slice(0, 160)}`,
        action: { label: "Ask Daedalus to fix it", run: () => void send(`The preview shows this error, please fix it:\n\n${e.message}${e.stack ? `\n\n${e.stack.split("\n").slice(0, 6).join("\n")}` : ""}`, "build", "build") },
      });
    },
    [running, send],
  );

  const startBuild = useCallback(() => void send("Looks good. Build it following the plan.", "build", "build"), [send]);
  const startReview = useCallback(() => {
    setView("chat");
    void send(REVIEW_MESSAGE, undefined, "review");
  }, [send]);

  // Suggested skills and rules: their status (so cards show Added / Not added after a reload) and
  // any error from applying one.
  const [suggestions, setSuggestions] = useState<Record<string, { status: string; error?: string }>>({});
  const [suggestionsKey, setSuggestionsKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api<{ suggestions: Array<{ id: string; status: string }> }>(`/api/projects/${project.id}/suggestions`)
      .then((r) => !cancelled && setSuggestions(Object.fromEntries(r.suggestions.map((x) => [x.id, { status: x.status }]))))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project.id, refreshKey, suggestionsKey]);
  const decideSuggestion = useCallback(
    (id: string, status: "kept" | "dismissed") => {
      setSuggestions((m) => ({ ...m, [id]: { status } }));
      void api(`/api/projects/${project.id}/suggestions`, { method: "PATCH", json: { id, status } })
        // A kept skill or rule changes what the Customize, Code and Agents panels show.
        .then(() => status === "kept" && setRefreshKey((k) => k + 1))
        .catch((e) => setSuggestions((m) => ({ ...m, [id]: { status: "proposed", error: e instanceof ApiError ? e.message : "Couldn't apply it" } })));
    },
    [project.id],
  );
  const answer = useCallback((text: string) => void send(text, undefined, "answer"), [send]);

  // Status of memories the agent proposed, so their cards show Kept / Not kept after a reload.
  const [memoryStatus, setMemoryStatus] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    api<{ memories: Array<{ id: string; status: string }> }>(`/api/projects/${project.id}/memories`)
      .then((r) => !cancelled && setMemoryStatus(Object.fromEntries(r.memories.map((m) => [m.id, m.status]))))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project.id, refreshKey]);
  const decideMemory = useCallback(
    (id: string, status: "kept" | "dismissed") => {
      setMemoryStatus((m) => ({ ...m, [id]: status }));
      void api(`/api/projects/${project.id}/memories`, { method: "PATCH", json: { id, status } }).catch(() => setMemoryStatus((m) => ({ ...m, [id]: "proposed" })));
    },
    [project.id],
  );

  // Select-to-edit: the user points at an element in the preview; we prefill a precise reference.
  const onSelect = useCallback((el: SelectedElement) => {
    const label = el.text ? `“${el.text.slice(0, 60)}”` : `<${el.tag}>`;
    setInput((v) => `${v ? `${v}\n` : ""}Change the ${el.tag} ${label} (at ${el.path}): `);
    setMode("build");
    setView("chat");
    setTimeout(() => {
      const box = document.getElementById("composer-input") as HTMLTextAreaElement | null;
      box?.focus();
      box?.setSelectionRange(box.value.length, box.value.length);
    }, 0);
  }, []);

  return (
    <div className="ws">
      <h1 className="sr-only">{name} · Daedalus workspace</h1>
      <header className="topbar">
        <Brand href="/" />
        <span className="faint hide-sm" aria-hidden="true">/</span>
        <ProjectName key={name} id={project.id} name={name} onRenamed={setName} />
        {running && (
          <span className="pill live" role="status">
            <span className="spin" /> {stopping ? "Stopping…" : runMode === "plan" ? "Planning" : "Building"}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="iconbtn hide-sm"
          aria-pressed={chatOnly}
          aria-label={chatOnly ? "Show the workspace panels" : "Full-screen chat"}
          title={chatOnly ? "Show the panels (⌘\\)" : "Full-screen chat (⌘\\)"}
          onClick={() => setChatOnly(!chatOnly)}
        >
          <Icon name={chatOnly ? "collapse" : "expand"} size={16} />
        </button>
        <div className="mobile-switch mode" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")}>Chat</button>
          <button type="button" aria-pressed={view === "panel"} onClick={() => setView("panel")}>Preview</button>
        </div>
        <VersionsMenu
          projectId={project.id}
          checkpoints={checkpoints}
          disabled={running}
          onRestored={() => {
            void refreshProject();
            setPreviewNonce((n) => n + 1);
            setRefreshKey((k) => k + 1);
          }}
        />
        <ShipMenu projectId={project.id} disabled={running} initialRepo={project.githubRepo} initialDeployUrl={project.deployUrl} />
        <UserMenu />
      </header>
      <div
        className={`ws-body${resizing ? " resizing" : ""}`}
        data-view={view}
        data-layout={chatOnly ? "chat" : "split"}
        ref={bodyRef}
        style={{ "--chat-w": `${chatWidth}px` } as React.CSSProperties}
      >
        <section className="chat" aria-label="Conversation">
          {!chatOnly && <ChatResizer width={chatWidth} container={() => bodyRef.current} onResize={setChatWidth} onDone={saveChatWidth} onDragging={setResizing} />}
          <div className="chat-scroll" id="chat-scroll">
            <Messages
              messages={messages}
              status={status}
              onStartBuild={startBuild}
              onAnswer={answer}
              memoryStatus={memoryStatus}
              onMemoryDecision={decideMemory}
              suggestions={suggestions}
              onSuggestionDecision={decideSuggestion}
              onRequestChanges={() => document.getElementById("composer-input")?.focus()}
              onOpenTrace={(id) => {
                if (id) setTraceRunId(id);
                setTab("trace");
                setView("panel");
                setChatOnly(false);
              }}
            />
            {error && !banner && (
              <div className="banner error" role="alert">
                <Icon name="alert" /> {error.message}
              </div>
            )}
          </div>
          <div className="chat-foot">
            {banner && (
              <div className={`banner ${banner.kind}`} role={banner.kind === "error" ? "alert" : "status"}>
                <Icon name={banner.kind === "error" ? "alert" : "info"} />
                <span style={{ flex: 1 }}>{banner.text}</span>
                {banner.action && (
                  <button className="btn sm" onClick={() => { const a = banner.action; setBanner(null); a?.run(); }}>
                    {banner.action.label}
                  </button>
                )}
                <button className="iconbtn" aria-label="Dismiss" onClick={() => setBanner(null)} style={{ width: 24, height: 24 }}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            )}
            <Composer
              compact
              value={input}
              onChange={setInput}
              onSubmit={() => void send(input)}
              mode={mode}
              onModeChange={setMode}
              running={running}
              onStop={() => void stop()}
              placeholder={messages.length ? "Ask for a change or the next feature · @ files · / skills" : "Describe what you want to build…"}
              label="Message Daedalus"
              projectId={project.id}
              onOpenCustomize={(section) => {
                setCustomizeAt((c) => ({ section, n: c.n + 1 }));
                setTab("customize");
                setView("panel");
                setChatOnly(false);
              }}
            />
          </div>
        </section>
        <section className="panel" aria-label="Workspace panels">
          <div className="tabs" role="tablist">
            {(
              [
                ["preview", "eye", "Preview"],
                ["code", "code", "Code"],
                ["trace", "flow", "Trace"],
                ["plan", "list", "Plan"],
                ["agents", "agents", "Agents"],
                ["customize", "gear", "Customize"],
              ] as const
            ).map(([id, icon, label]) => (
              <button key={id} role="tab" className="tab" aria-selected={tab === id} aria-controls={`panel-${id}`} id={`tab-${id}`} onClick={() => setTab(id)}>
                <Icon name={icon} size={14} /> {label}
              </button>
            ))}
          </div>
          <div className="tabpanel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {/* Kept mounted on every tab: the app keeps its state, and the agent's checks can reload it. */}
            <div style={{ display: tab === "preview" ? "contents" : "none" }}>
              <PreviewPanel
                projectId={project.id}
                url={previewUrl}
                nonce={previewNonce}
                checkId={checkId}
                running={running}
                onUrl={setPreviewUrl}
                onError={onPreviewError}
                onSelect={onSelect}
              />
            </div>
            {tab === "code" && <CodePanel projectId={project.id} refreshKey={refreshKey} hasSandbox={Boolean(previewUrl)} />}
            {tab === "trace" && <TracePanel projectId={project.id} runId={traceRunId} onSelectRun={setTraceRunId} live={running} />}
            {tab === "plan" && <PlanPanel messages={messages} onStartBuild={startBuild} running={running} />}
            {tab === "agents" && <AgentsPanel projectId={project.id} refreshKey={refreshKey} hasSandbox={Boolean(previewUrl)} />}
            {tab === "customize" && (
              <CustomizePanel key={customizeAt.n} projectId={project.id} refreshKey={refreshKey} hasSandbox={Boolean(previewUrl)} initialSection={customizeAt.section} onReview={running ? undefined : startReview} onSuggestionsChanged={() => setSuggestionsKey((k) => k + 1)} />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function ProjectName({ id, name, onRenamed }: { id: string; name: string; onRenamed(n: string): void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  if (!editing) {
    return (
      <button className="pname" onClick={() => setEditing(true)} title="Rename project">
        {name}
      </button>
    );
  }
  const save = async () => {
    setEditing(false);
    const v = value.trim();
    if (!v || v === name) return;
    onRenamed(v);
    await api(`/api/projects/${id}`, { method: "PATCH", json: { name: v } }).catch(() => onRenamed(name));
  };
  return (
    <input
      className="input"
      style={{ maxWidth: 260, minHeight: 32, padding: "4px 8px", fontSize: 14 }}
      autoFocus
      value={value}
      aria-label="Project name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === "Enter") void save();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}
