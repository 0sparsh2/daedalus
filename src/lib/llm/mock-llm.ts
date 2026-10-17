/**
 * A scripted, OpenAI-compatible chat-completions server. It lets tests drive the real
 * harness (gateway, workflow, tools, sandbox, UI) deterministically without a paid key.
 *
 * Pick a script by putting `[mock:<name>]` in a user message. The mock replays the script
 * turn by turn: turn N is chosen by how many assistant messages follow the last user message.
 */

export interface MockToolCall {
  name: string;
  args: Record<string, unknown>;
}
export interface MockTurn {
  reasoning?: string;
  text?: string;
  toolCalls?: MockToolCall[];
}

type ChatMessage = {
  role: string;
  content?: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: unknown[];
};

const HELLO_APP = `import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="min-h-screen grid place-items-center bg-amber-50 text-stone-900">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold">Hello from Daedalus</h1>
        <button className="rounded-lg bg-stone-900 px-4 py-2 text-white" onClick={() => setCount((c) => c + 1)}>
          Clicked {count} times
        </button>
      </div>
    </main>
  );
}
`;

export const MOCK_SCENARIOS: Record<string, MockTurn[]> = {
  echo: [
    { text: "Calling the echo tool.", toolCalls: [{ name: "echo", args: { text: "hello from the mock" } }] },
    { text: "The echo tool answered. Done." },
  ],
  hello: [
    {
      reasoning: "The user wants a simple page. I'll plan, write App.tsx, then verify.",
      text: "I'll set up a short task list first.",
      toolCalls: [{ name: "update_todos", args: { todos: [{ content: "Write the greeting page", status: "in_progress" }, { content: "Verify the build", status: "pending" }] } }],
    },
    { text: "Writing the page.", toolCalls: [{ name: "write_file", args: { path: "src/App.tsx", content: HELLO_APP } }] },
    { text: "Checking that it compiles and renders.", toolCalls: [{ name: "verify", args: {} }, { name: "check_preview", args: {} }] },
    { text: "Your greeting page is live in the preview, with a counter button." },
  ],
  broken: [
    { text: "Writing a component.", toolCalls: [{ name: "write_file", args: { path: "src/App.tsx", content: "export default function App() {\n  return <div>{undefinedVar}</div>;\n}\n" } }] },
    { text: "All done." },
    { text: "The automatic check found a type error. Fixing it.", toolCalls: [{ name: "write_file", args: { path: "src/App.tsx", content: HELLO_APP } }] },
    { text: "Fixed: the page compiles and the preview works." },
  ],
  research: [
    { text: "Let me ask a research sub-agent.", toolCalls: [{ name: "research", args: { task: "[mock:research-sub] Which React version does this project use?" } }] },
    { text: "The research sub-agent reported back. Done." },
  ],
  slow: [
    { text: "Writing a file, then running a long command.", toolCalls: [{ name: "write_file", args: { path: "src/notes.txt", content: "work in progress\n" } }] },
    { text: "Now the slow part.", toolCalls: [{ name: "run_command", args: { command: "sleep 12 && echo finished" } }] },
    { text: "This turn should never be reached when the run is stopped." },
  ],
  explore: [
    { text: "Looking around the imported project.", toolCalls: [{ name: "list_files", args: {} }, { name: "read_file", args: { path: "package.json" } }] },
    { text: "Checking that it runs.", toolCalls: [{ name: "check_preview", args: {} }] },
    { text: "This is a React todo app built with Vite. It runs in the preview; nothing was changed." },
  ],
  // Schema drift seen from real open models: a misspelt key holding a JSON-encoded array, and
  // another harness's key names. The repair layer should fix both without a retry.
  drift: [
    {
      text: "Planning the work.",
      toolCalls: [{ name: "update_todos", args: { tos: JSON.stringify([{ content: "Write the page", status: "in_progress" }, { content: "Verify", status: "pending" }]) } }],
    },
    { text: "Writing the page.", toolCalls: [{ name: "write_file", args: { filePath: "src/App.tsx", contents: HELLO_APP } }] },
    { text: "Both tool calls went through. Done." },
  ],
  // Customize: the agent loads a project skill, then a built-in the project switched off.
  skill: [
    { text: "Loading the project's brand voice.", toolCalls: [{ name: "skill", args: { name: "brand-voice" } }] },
    { text: "And the charts playbook.", toolCalls: [{ name: "skill", args: { name: "charts" } }] },
    { text: "Skills checked." },
  ],
  // Rules that always run: a blocked command, an after-change command, and a before-finish
  // rule that fails until the agent creates the file it checks for.
  rules: [
    { text: "Adding a package.", toolCalls: [{ name: "run_command", args: { command: "npm install left-pad" } }] },
    { text: "Writing notes instead.", toolCalls: [{ name: "write_file", args: { path: "src/notes.txt", content: "hello\n" } }] },
    { text: "Done." },
    { text: "A project rule failed. Creating the file it expects.", toolCalls: [{ name: "write_file", args: { path: "src/rule-ok.txt", content: "ok\n" } }] },
    { text: "Fixed: the project rule passes now." },
  ],
  // Connections: a read-only tool works while planning; a tool that isn't read-only doesn't.
  "mcp-plan": [
    { text: "Looking up React's docs.", toolCalls: [{ name: "mcp__context7__resolve-library-id", args: { query: "React hooks", libraryName: "react" } }] },
    { text: "And the repository's wiki.", toolCalls: [{ name: "mcp__deepwiki__read_wiki_structure", args: { repoName: "vercel/ai" } }] },
    { text: "Planning with what I found." },
  ],
  // While building, every connected tool is available.
  "mcp-build": [
    { text: "Reading the repository's wiki.", toolCalls: [{ name: "mcp__deepwiki__read_wiki_structure", args: { repoName: "vercel/ai" } }] },
    { text: "Got it." },
  ],
  // Memory: the agent proposes a fact; the user keeps or discards it.
  remember: [
    { text: "Noting that for next time.", toolCalls: [{ name: "remember", args: { text: "Use metric units throughout", scope: "project" } }] },
    { text: "Noted." },
  ],
  "research-sub": [
    { text: "Reading package.json.", toolCalls: [{ name: "read_file", args: { path: "package.json" } }] },
    { text: "The project uses React 19.3.1 with Vite 8.\n\nSources: package.json" },
  ],
  plan: [
    { text: "Looking at the project first.", toolCalls: [{ name: "list_files", args: {} }] },
    {
      text: "Here's the plan.",
      toolCalls: [
        {
          name: "propose_plan",
          args: {
            title: "Clinic Booking",
            summary: "A booking app for a small clinic: patients pick a service and a time; staff see the day's appointments.",
            features: ["Service picker", "Calendar with free slots", "Booking form", "Staff day view"],
            design: "Calm teal and white, rounded cards, large touch targets.",
            steps: ["Layout and navigation", "Services and slots data", "Booking flow", "Staff view", "Polish and verify"],
            assumptions: ["No payments in v1", "Bookings saved in the browser"],
          },
        },
      ],
    },
  ],
};

export function isMockEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.DAEDALUS_ENABLE_MOCK === "1";
}

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? "").join("");
  return "";
}

export function pickTurn(messages: ChatMessage[], toolNames: string[]): MockTurn {
  let lastUser = -1;
  let tagged = -1;
  let scenario: string | undefined;
  messages.forEach((m, i) => {
    if (m.role !== "user") return;
    lastUser = i;
    const match = textOf(m.content).match(/\[mock:([a-z0-9_-]+)\]/i);
    if (match) {
      scenario = match[1];
      tagged = i;
    }
  });
  // Test-only: reply with the instructions and memory sections of the system prompt, to prove
  // they reach the model.
  if (scenario === "memory-echo") {
    const system = textOf(messages.find((m) => m.role === "system")?.content);
    const section = (title: string) => system.split(`# ${title}`)[1]?.split("\n# ")[0]?.trim() ?? "(missing)";
    return { text: `INSTRUCTIONS: ${section("The user's instructions (for all their projects)")}\nMEMORY: ${section("What the user asked you to remember")}` };
  }
  const script = scenario ? MOCK_SCENARIOS[scenario] : undefined;
  if (script) {
    // Harness-injected messages (automatic checks) don't restart the script.
    const turn = messages.slice(tagged + 1).filter((m) => m.role === "assistant").length;
    return script[turn] ?? { text: "Done." };
  }
  const assistantTurns = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
  if (assistantTurns === 0 && toolNames.length > 0 && /\buse tools?\b/i.test(textOf(messages[lastUser]?.content))) {
    return { text: "Using a tool.", toolCalls: [{ name: toolNames[0], args: {} }] };
  }
  return { text: assistantTurns === 0 ? "Hello from the mock model." : "Done." };
}

function chunk(id: string, model: string, delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function splitText(text: string, size = 12): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export async function handleMockChatCompletions(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    model?: string;
    stream?: boolean;
    messages?: ChatMessage[];
    tools?: Array<{ function?: { name?: string } }>;
  };
  const model = body.model ?? "mock-builder";
  const toolNames = (body.tools ?? []).map((t) => t.function?.name ?? "").filter(Boolean);
  const turn = pickTurn(body.messages ?? [], toolNames);
  const id = `chatcmpl-mock-${Math.random().toString(36).slice(2, 10)}`;
  const toolCalls = (turn.toolCalls ?? []).map((c, i) => ({
    id: `call_${Math.random().toString(36).slice(2, 10)}_${i}`,
    type: "function",
    function: { name: c.name, arguments: JSON.stringify(c.args) },
  }));
  const finish = toolCalls.length ? "tool_calls" : "stop";
  const usage = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 };

  if (!body.stream) {
    return Response.json({
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: turn.text ?? null,
            ...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finish,
        },
      ],
      usage,
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(encoder.encode(s));
      const pause = () => new Promise((r) => setTimeout(r, 15));
      send(chunk(id, model, { role: "assistant", content: "" }));
      for (const part of splitText(turn.reasoning ?? "")) {
        send(chunk(id, model, { reasoning_content: part }));
        await pause();
      }
      for (const part of splitText(turn.text ?? "")) {
        send(chunk(id, model, { content: part }));
        await pause();
      }
      toolCalls.forEach((call, index) => {
        send(chunk(id, model, { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] }));
        send(chunk(id, model, { tool_calls: [{ index, function: { arguments: call.function.arguments } }] }));
      });
      send(chunk(id, model, {}, finish));
      send(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage })}\n\n`);
      send("data: [DONE]\n\n");
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
