import { tool } from "ai";
import { z } from "zod";
import { suggestInputSchema } from "@/lib/suggestions";
import { runScopeSchema, type RunScope, type ToolOutput } from "../scope";
import * as steps from "./steps";

/**
 * The model-facing tool set. Each `execute` is a thin wrapper that runs in the workflow and
 * calls a durable step with only (input, toolCallId, scope). The model reads `text`; the UI
 * also gets the structured fields (diffs, exit codes, todo lists).
 */

type Opts = { toolCallId: string; context: RunScope };
const ctx = (o: Opts) => ({ toolCallId: o.toolCallId, scope: o.context });
const toModelOutput = ({ output }: { output: unknown }) => ({ type: "text" as const, value: (output as ToolOutput)?.text ?? JSON.stringify(output) });
const path = z.string().describe("Path relative to the project root, e.g. src/App.tsx");

// Like OpenCode's question tool and Claude Code's AskUserQuestion, but the turn ends instead
// of blocking: the user's answer arrives as their next message, so a durable run never waits.
export const askUserSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().describe("One short, concrete question"),
        options: z
          .array(z.string())
          .max(5)
          .optional()
          .describe("2-4 likely answers. Put the one you recommend first and add \" (Recommended)\" to it. The user can always type their own."),
      }),
    )
    .min(1)
    .max(4),
});

export const todoSchema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().describe("Short imperative task, e.g. “Build the booking form”"),
        status: z.enum(["pending", "in_progress", "completed"]),
      }),
    )
    .min(1)
    .max(20),
});

export const planSchema = z.object({
  title: z.string().describe("Name of the app, 2-5 words"),
  summary: z.string().describe("What it is and who it's for, in 2-3 plain sentences"),
  // Generous caps: rejecting a good plan over a 13th feature costs a whole model call.
  features: z.array(z.string()).min(1).max(20).describe("Key screens and features for the first version"),
  design: z.string().describe("Visual direction: mood, colours, typography, layout"),
  steps: z.array(z.string()).min(1).max(16).describe("Build steps, in order"),
  assumptions: z.array(z.string()).max(12).optional().describe("Assumptions you made"),
  questions: z.array(z.string()).max(5).optional().describe("Up to 3 questions whose answers would change the plan"),
});

export function buildTools() {
  // Tool calls in one step run concurrently. Mutations of the same file are chained here, in
  // the workflow (deterministic on replay), so two edits to one file can't overwrite each
  // other; reads, commands and sub-agents stay parallel.
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T,>(path: string, run: () => Promise<T>): Promise<T> => {
    const key = path.replace(/^\.\//, "");
    const next = (chains.get(key) ?? Promise.resolve()).then(run, run);
    chains.set(key, next.catch(() => undefined));
    return next;
  };
  return {
    list_files: tool({
      description: "List the project's files as a tree (node_modules, .git and dist are skipped).",
      inputSchema: z.object({ path: path.optional(), depth: z.number().int().min(1).max(10).optional() }),
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.listFilesStep(input, ctx(o as Opts)),
      toModelOutput,
    }),
    read_file: tool({
      description:
        "Read a text file. Each line is prefixed with its line number as `N: `; the prefix is not part of the file. Reads up to 2000 lines; use offset/limit for longer files.",
      inputSchema: z.object({ path, offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(2000).optional() }),
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.readFileStep(input, ctx(o as Opts)),
      toModelOutput,
    }),
    write_file: tool({
      description: "Create a new file or completely replace a file's contents. Parent folders are created. Prefer edit_file for small changes to existing files.",
      inputSchema: z.object({ path, content: z.string().describe("The complete file contents") }),
      contextSchema: runScopeSchema,
      execute: (input, o) => serial(input.path, () => steps.writeFileStep(input, ctx(o as Opts))),
      toModelOutput,
    }),
    edit_file: tool({
      description:
        "Replace text in an existing file. old_string must match the current file text exactly once (copy it from read_file without the line-number prefixes) unless replace_all is true. Small differences in quotes, trailing spaces or indentation are tolerated.",
      inputSchema: z.object({
        path,
        old_string: z.string().describe("Exact text to replace, with enough surrounding lines to be unique"),
        new_string: z.string().describe("Replacement text"),
        replace_all: z.boolean().optional().describe("Replace every occurrence (e.g. renaming)"),
      }),
      contextSchema: runScopeSchema,
      execute: (input, o) => serial(input.path, () => steps.editFileStep(input, ctx(o as Opts))),
      toModelOutput,
    }),
    delete_file: tool({
      description: "Delete a file or folder in the project.",
      inputSchema: z.object({ path }),
      contextSchema: runScopeSchema,
      execute: (input, o) => serial(input.path, () => steps.deleteFileStep(input, ctx(o as Opts))),
      toModelOutput,
    }),
    glob: tool({
      description: 'Find files by name pattern, e.g. "src/**/*.tsx" or "**/*.css".',
      inputSchema: z.object({ pattern: z.string(), path: path.optional() }),
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.globStep(input, ctx(o as Opts)),
      toModelOutput,
    }),
    grep: tool({
      description: "Search file contents with a regular expression (ripgrep). Returns matching lines as path:line:text.",
      inputSchema: z.object({
        pattern: z.string(),
        path: path.optional(),
        glob: z.string().optional().describe('Limit to files matching this glob, e.g. "*.tsx"'),
        literal: z.boolean().optional().describe("Treat pattern as plain text"),
        ignore_case: z.boolean().optional(),
      }),
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.grepStep(input, ctx(o as Opts)),
      toModelOutput,
    }),
    run_command: tool({
      description:
        "Run a shell command (bash) in the project root, e.g. `npm install zustand` or `npx shadcn@latest add button`. Non-interactive only. Times out after 120 s by default (max 240). Don't start the dev server; it is already running.",
      inputSchema: z.object({
        command: z.string(),
        cwd: path.optional().describe("Working directory relative to the project root"),
        timeout_seconds: z.number().int().min(5).max(240).optional(),
      }),
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.runCommandStep(input, ctx(o as Opts)),
      toModelOutput,
    }),
    dev_server: tool({
      description: "Check, restart or read the logs of the app's dev server (port 5173).",
      inputSchema: z.object({ action: z.enum(["status", "restart", "logs"]) }),
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.devServerStep(input, ctx(o as Opts)),
      toModelOutput,
    }),
    check_preview: tool({
      description:
        "Check the live app the way a browser loads it: compiles every module reachable from index.html and reports compile errors, plus runtime errors the user's browser reported. Run after making changes.",
      inputSchema: z.object({}),
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.checkPreviewStep(input as Record<string, never>, ctx(o as Opts)),
      toModelOutput,
    }),
    verify: tool({
      description: "Type-check (tsc) and run a production build. Returns the errors to fix. Run before you finish.",
      inputSchema: z.object({}),
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.verifyStep(input as Record<string, never>, ctx(o as Opts)),
      toModelOutput,
    }),
    update_todos: tool({
      description: "Create or update your task list for this request. Send the whole list every time. Keep exactly one item in_progress while working.",
      inputSchema: todoSchema,
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.todosStep(input, ctx(o as Opts)),
      toModelOutput,
    }),
    research: tool({
      description:
        "Delegate a research question to a sub-agent that can search the web and read pages (and read this project). It works in its own context and returns only a concise answer with sources. Use for current library APIs, docs, or design references. Several can run in parallel.",
      inputSchema: z.object({ task: z.string().describe("A precise, self-contained research question with the context the sub-agent needs") }),
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.researchStep(input, ctx(o as Opts)),
      toModelOutput,
    }),
    explore: tool({
      description: "Delegate read-only exploration of this codebase to a sub-agent that maps files, structure and where to make a change, and reports back concisely.",
      inputSchema: z.object({ task: z.string().describe("What to find out about the codebase") }),
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.exploreStep(input, ctx(o as Opts)),
      toModelOutput,
    }),
    skill: tool({
      description:
        "Load a skill: a playbook for a specific kind of work (charts, forms, routing, your team's own conventions). Call it when a task matches a skill listed in your instructions, then follow what it says.",
      inputSchema: z.object({ name: z.string().describe("The skill's name, exactly as listed") }),
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.skillStep(input, ctx(o as Opts)),
      toModelOutput,
    }),
    remember: tool({
      description:
        "Propose one fact to remember for future turns: a lasting preference, a decision about the project, or a correction that should hold. The user keeps or discards it; only kept memories are used. Never secrets or personal data.",
      inputSchema: z.object({
        text: z.string().min(3).max(500).describe("The fact, in one plain sentence, e.g. 'Use metric units throughout'"),
        scope: z.enum(["project", "me"]).optional().describe("project (default): this app only; me: all of the user's projects"),
      }),
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.rememberStep(input, ctx(o as Opts)),
      toModelOutput,
    }),
    suggest: tool({
      description:
        "Suggest a skill or a rule for this project, when this conversation showed a procedure worth reusing (skill) or something that must happen every time (rule). The user keeps or discards it; nothing changes until they keep it. For a short fact or preference, use remember instead.",
      inputSchema: suggestInputSchema,
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.suggestStep(input, ctx(o as Opts)),
      toModelOutput,
    }),
    read_run: tool({
      description: "Read one of the project's past runs in full: the request, every step and tool result, the automatic checks, and the user's next message. Use the run ids listed under Recent runs.",
      inputSchema: z.object({ runId: z.string().describe("A run id from the Recent runs list") }),
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.readRunStep(input, ctx(o as Opts)),
      toModelOutput,
    }),
    ask_user: tool({
      description:
        "Ask the user up to 4 short questions when an answer would change what you build (who it's for, the core flow, a choice between approaches). Offer likely answers as options. Your turn ends here; the answers come in the user's next message. Don't use it for things you can decide sensibly yourself.",
      inputSchema: askUserSchema,
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.askUserStep(input, ctx(o as Opts)),
      toModelOutput,
    }),
    propose_plan: tool({
      description:
        "Present a complete plan for the user to approve, when the request is a buildable idea. Don't call it for greetings, questions or ideas too vague to plan (ask with ask_user instead), and never with placeholder content.",
      inputSchema: planSchema,
      contextSchema: runScopeSchema,
      execute: (input, o) => steps.proposePlanStep(input, ctx(o as Opts)),
      toModelOutput,
    }),
  };
}

export type DaedalusTools = ReturnType<typeof buildTools>;
export type ToolName = keyof DaedalusTools;

/** Tool sets per route. chat has none; ask and plan are read-only; only build changes files. */
export const ASK_TOOLS: ToolName[] = ["list_files", "read_file", "glob", "grep", "research", "explore", "skill", "remember", "suggest", "ask_user"];
export const PLAN_TOOLS: ToolName[] = ["list_files", "read_file", "glob", "grep", "research", "explore", "skill", "remember", "suggest", "ask_user", "propose_plan"];
/** Review turns read the project and its past runs, and can only suggest. */
export const REVIEW_TOOLS: ToolName[] = ["list_files", "read_file", "glob", "grep", "skill", "read_run", "suggest", "remember"];
export const BUILD_TOOLS: ToolName[] = [
  "list_files",
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "glob",
  "grep",
  "run_command",
  "dev_server",
  "check_preview",
  "verify",
  "update_todos",
  "research",
  "explore",
  "skill",
  "remember",
  "suggest",
  "ask_user",
];
