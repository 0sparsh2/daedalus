import "server-only";
import { ToolLoopAgent, isStepCount, jsonSchema, tool, type JSONSchema7, type UIMessageChunk } from "ai";
import { getWritable } from "workflow";
import { z } from "zod";
import { GatewayModel } from "@/lib/llm/gateway-model";
import { mintRunToken } from "@/lib/llm/run-token";
import type { AnyProviderId } from "@/lib/llm/providers";
import { attachProjectSandbox, type SandboxHandle } from "@/lib/sandbox";
import { addRunUsage, endSpan, recordSpan, startSpan } from "@/lib/trace/spans";
import { EXPLORE_PROMPT, RESEARCH_PROMPT } from "./prompts";
import { callConnectionTool, connectionTools } from "@/lib/mcp/connections";
import { ToolError, errorDetail, stableId, truncateMiddle } from "./runtime";
import { findInjection, injectionNote } from "./injection";
import type { RunScope, ToolOutput } from "./scope";
import * as impl from "./tools/impl";
import { webFetch, webSearch } from "./tools/web";

/**
 * Sub-agents run inside one durable step as an in-process ToolLoopAgent with their own fresh
 * context window. Tracing: the sub-agent gets its own span; its model calls carry a run token
 * scoped to that span (so the gateway nests them), and each of its tool calls records a child
 * span. Progress streams to the chat as `data-subagent` parts keyed by the parent tool call.
 * Only the final summary returns to the main agent, which keeps its context small.
 */

export type SubagentKind = "research" | "explore";

export interface SubagentProgress {
  kind: SubagentKind;
  task: string;
  status: "running" | "done" | "error";
  model: string;
  spanId: string;
  steps: Array<{ tool: string; label: string; ok?: boolean }>;
  summary?: string;
}

function label(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "web_search":
      return `Searched “${input.query}”`;
    case "web_fetch":
      try {
        const u = new URL(String(input.url));
        return `Read ${u.host}${u.pathname.length > 1 ? u.pathname.slice(0, 40) : ""}`;
      } catch {
        return "Read a page";
      }
    case "read_file":
      return `Read ${input.path}`;
    case "grep":
      return `Searched code for “${input.pattern}”`;
    case "glob":
      return `Listed ${input.pattern}`;
    case "list_files":
      return "Listed project files";
    default:
      return toolName;
  }
}

export async function runSubagent(
  kind: SubagentKind,
  input: { task: string },
  ctx: { toolCallId: string; scope: RunScope },
): Promise<ToolOutput> {
  const { scope, toolCallId } = ctx;
  const spanId = stableId(scope.runId, toolCallId);
  const startedAt = new Date();
  const progress: SubagentProgress = { kind, task: input.task, status: "running", model: scope.subagentModel, spanId, steps: [] };
  const writer = getWritable<UIMessageChunk>().getWriter();
  const emit = async () => {
    await writer.write({ type: "data-subagent", id: toolCallId, data: { ...progress, steps: [...progress.steps] } }).catch(() => {});
  };

  await startSpan({
    id: spanId,
    runId: scope.runId,
    projectId: scope.projectId,
    userId: scope.userId,
    parentId: scope.runId,
    kind: "subagent",
    name: `${kind} sub-agent`,
    input,
    attrs: { toolCallId, model: scope.subagentModel, provider: scope.provider },
  });
  await emit();

  let sandbox: SandboxHandle | undefined;
  const getSandbox = async () => (sandbox ??= await attachProjectSandbox(scope.projectId));
  // What the tools found, kept so a sub-agent that fails or writes nothing still reports back.
  const findings: string[] = [];

  // Each sub-agent tool records a child span under the sub-agent span.
  const traced = <I extends Record<string, unknown>>(name: string, fn: (input: I) => Promise<ToolOutput>) =>
    async (toolInput: I): Promise<string> => {
      const step = { tool: name, label: label(name, toolInput) } as SubagentProgress["steps"][number];
      progress.steps.push(step);
      await emit();
      const t0 = new Date();
      let out: ToolOutput;
      try {
        out = await fn(toolInput);
      } catch (err) {
        out = { ok: false, text: `Error: ${err instanceof ToolError || err instanceof Error ? err.message : String(err)}` };
      }
      const injected = out.ok ? findInjection(out.text) : null;
      if (injected) out = { ...out, text: `${out.text}${injectionNote(injected)}` };
      step.ok = out.ok;
      if (out.ok) findings.push(`${name} ${step.label}:\n${out.text.slice(0, 700)}`);
      await Promise.all([
        emit(),
        recordSpan({
          runId: scope.runId,
          projectId: scope.projectId,
          userId: scope.userId,
          parentId: spanId,
          kind: "tool",
          name,
          status: out.ok ? "ok" : "error",
          startedAt: t0,
          endedAt: new Date(),
          input: toolInput,
          output: { text: out.text.slice(0, 1500) },
          error: out.ok ? undefined : out.text,
        }),
        addRunUsage(scope.runId, { toolCalls: 1 }),
      ]);
      return out.text;
    };

  const readOnly = {
    read_file: tool({
      description: "Read a project file with line numbers.",
      inputSchema: z.object({ path: z.string(), offset: z.number().int().optional(), limit: z.number().int().optional() }),
      execute: traced("read_file", async (i: { path: string; offset?: number; limit?: number }) => impl.readFile(await getSandbox(), i)),
    }),
    grep: tool({
      description: "Search project file contents with a regular expression.",
      inputSchema: z.object({ pattern: z.string(), path: z.string().optional(), glob: z.string().optional() }),
      execute: traced("grep", async (i: { pattern: string; path?: string; glob?: string }) => impl.grep(await getSandbox(), i)),
    }),
    glob: tool({
      description: 'Find project files by glob pattern, e.g. "src/**/*.tsx".',
      inputSchema: z.object({ pattern: z.string() }),
      execute: traced("glob", async (i: { pattern: string }) => impl.glob(await getSandbox(), i)),
    }),
    list_files: tool({
      description: "List the project's files as a tree.",
      inputSchema: z.object({ path: z.string().optional() }),
      execute: traced("list_files", async (i: { path?: string }) => impl.listFiles(await getSandbox(), i)),
    }),
  };

  const tools =
    kind === "research"
      ? {
          web_search: tool({
            description: "Search the web. Returns titles, URLs and snippets.",
            inputSchema: z.object({ query: z.string(), max_results: z.number().int().min(1).max(10).optional() }),
            execute: traced("web_search", (i: { query: string; max_results?: number }) => webSearch(i)),
          }),
          web_fetch: tool({
            description: "Fetch a web page or document and return its readable text.",
            inputSchema: z.object({ url: z.string(), max_chars: z.number().int().optional() }),
            execute: traced("web_fetch", (i: { url: string; max_chars?: number }) => webFetch(i)),
          }),
          read_file: readOnly.read_file,
          grep: readOnly.grep,
          // The project's read-only connections (docs services and the like) are research tools too.
          ...Object.fromEntries(
            (await connectionTools(scope.projectId).catch(() => []))
              .filter((d) => d.readOnly)
              .map((d) => [
                d.key,
                tool({
                  description: d.description,
                  inputSchema: jsonSchema<Record<string, unknown>>(d.inputSchema as JSONSchema7),
                  execute: traced(d.key, async (args: Record<string, unknown>) => {
                    const r = await callConnectionTool(scope.userId, d.connectionId, d.tool, args ?? {});
                    return { ok: !r.isError, text: truncateMiddle(r.text, 8000) };
                  }),
                }),
              ]),
          ),
        }
      : readOnly;

  const token = await mintRunToken({
    userId: scope.userId,
    runId: scope.runId,
    projectId: scope.projectId,
    provider: scope.provider as AnyProviderId,
    spanId,
    agent: kind,
  });
  const maxSteps = kind === "research" ? 12 : 16;
  const agent = new ToolLoopAgent({
    model: new GatewayModel({ provider: scope.provider as AnyProviderId, modelId: scope.subagentModel, gatewayURL: scope.gatewayURL, token }),
    instructions: kind === "research" ? RESEARCH_PROMPT : EXPLORE_PROMPT,
    tools,
    stopWhen: isStepCount(maxSteps),
    // The last step has no tools, so the sub-agent ends with a written answer, not a tool call.
    prepareStep: ({ stepNumber }) => (stepNumber >= maxSteps - 1 ? { activeTools: [] } : undefined),
    maxRetries: 3,
    maxOutputTokens: 8_192,
    providerOptions: scope.subagentRequestOptions ? { [scope.provider]: scope.subagentRequestOptions as Record<string, never> } : undefined,
  });

  // Some models write typographic hyphens and spaces (U+2011, U+00AD, U+202F), which break URLs
  // and identifiers when the main agent copies them into code.
  const plain = (t: string) => t.replace(/[\u2010\u2011]/g, "-").replace(/\u00AD/g, "").replace(/[\u00A0\u202F]/g, " ");
  const digest = () => plain(findings.slice(-6).join("\n\n"));
  try {
    const result = await agent.generate({ prompt: input.task, timeout: { totalMs: 200_000 } });
    const written = plain(result.text.trim());
    const summary =
      written ||
      (findings.length
        ? `The ${kind} sub-agent didn't write a summary. What its tools found:\n\n${digest()}`
        : `The ${kind} sub-agent finished without findings. Continue without it or try a narrower task.`);
    progress.status = "done";
    progress.summary = summary;
    await emit();
    await endSpan(spanId, { status: "ok", output: { summary: summary.slice(0, 3000) }, startedAt, attrs: { steps: result.steps.length, wroteSummary: Boolean(written) } });
    return { ok: Boolean(written) || findings.length > 0, text: summary, kind, steps: progress.steps.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = errorDetail(err);
    console.error(`[subagent] ${kind} failed:`, detail);
    progress.status = "error";
    progress.summary = message;
    await emit();
    await endSpan(spanId, { status: "error", error: detail, startedAt, attrs: { findings: findings.length } });
    // Partial findings are still worth having; the main agent decides what to do with them.
    return findings.length
      ? { ok: true, text: `The ${kind} sub-agent stopped early (${message}). What it found before stopping:\n\n${digest()}`, kind, partial: true }
      : { ok: false, text: `The ${kind} sub-agent failed: ${message}. Continue without it or try a narrower task.` };
  } finally {
    writer.releaseLock();
  }
}
