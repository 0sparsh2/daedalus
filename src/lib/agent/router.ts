/**
 * The turn router: decides what a user message is for before any heavy machinery starts.
 *
 *   1. Actions (free): what the user clicked, e.g. "Start building" or answering a question card.
 *   2. Rules (free): small talk ("hi", "thanks") and scripted test turns.
 *   3. The classifier (one fast-model call, ~1 s): everything else.
 *
 * Routes are agent profiles (prompt + tools + budget): chat (no sandbox, no tools), ask
 * (read-only questions about the app), plan (read-only; a plan is optional) and build. The
 * user's Plan/Build toggle is a ceiling, not a script: Plan never writes, Build may, and any
 * route can simply reply. This mirrors how OpenCode, Claude Code and Codex treat modes as
 * permission profiles over one loop, with a small model for side decisions.
 *
 * Pure functions only (they run in the durable workflow and in unit tests).
 */

export const ROUTES = ["chat", "ask", "plan", "build"] as const;
export type Route = (typeof ROUTES)[number];
export type Mode = "plan" | "build";
/** What the user did, when it says more than the text: pressed "Start building", answered questions. */
export type Intent = "build" | "answer";

export interface RouteDecision {
  route: Route;
  by: "action" | "rule" | "model" | "default";
  reason: string;
}

export const ALLOWED: Record<Mode, readonly Route[]> = { plan: ["chat", "ask", "plan"], build: ["chat", "ask", "build"] };

/** Keeps a route inside the user's mode: Plan never builds, and in Build "plan this" becomes a build. */
export function fitToMode(route: Route, mode: Mode): Route {
  return ALLOWED[mode].includes(route) ? route : mode;
}

const SMALL_TALK =
  /^(?:hi+|hello+|hey+|heya|hiya|yo|howdy|sup|what'?s up|good (?:morning|afternoon|evening)|thanks?|thank you|thx|ty|cheers|ok(?:ay)?|k|cool|nice|great|awesome|perfect|got it|sounds good|lol|haha|bye|see you)(?: there| daedalus| so much| a lot| again| you)?$/;

/** A greeting, thanks or acknowledgement with nothing else in it (emoji-only counts too). */
export function isSmallTalk(text: string): boolean {
  const t = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t === "" || SMALL_TALK.test(t);
}

export function ruleRoute(input: { text: string; mode: Mode; intent?: Intent }): RouteDecision | null {
  if (input.intent === "build") return { route: fitToMode("build", input.mode), by: "action", reason: "Pressed Start building" };
  if (input.intent === "answer") return { route: input.mode, by: "action", reason: "Answered the agent's questions" };
  if (/\[mock:[a-z0-9_-]+\]/i.test(input.text)) return { route: input.mode, by: "rule", reason: "Scripted test turn" };
  if (isSmallTalk(input.text)) return { route: "chat", by: "rule", reason: "Greeting or acknowledgement" };
  return null;
}

/** Reads the classifier's answer: JSON first, then a bare route word. */
export function parseRoute(text: string): { route: Route; reason: string } | null {
  const json = text.match(/\{[^{}]*"route"[^{}]*\}/);
  if (json) {
    try {
      const j = JSON.parse(json[0]) as { route?: string; reason?: unknown };
      const route = String(j.route ?? "").toLowerCase() as Route;
      if (ROUTES.includes(route)) return { route, reason: String(j.reason ?? "").slice(0, 160) };
    } catch {
      // fall through to the bare word
    }
  }
  const word = text.toLowerCase().match(/\b(chat|ask|plan|build)\b/);
  return word ? { route: word[1] as Route, reason: "" } : null;
}

export const ROUTER_PROMPT = `You route messages for Daedalus, an AI app builder. Read the user's latest message (with a little context) and decide what it is for. Answer with JSON only.

Routes:
- "chat": greetings, thanks, small talk, and questions about Daedalus itself: what it can build, how it works, how it saves work or versions, deploying, GitHub, models and keys. Also general questions that don't need this project's files.
- "ask": a question about THIS project's app or its code, answered by reading its files: "which file renders the home page?", "why is the button grey?", "how does the streak work?". Nothing gets changed.
- "plan": an app or feature idea to think through before building, or a request for a plan, options or ideas for this project.
- "build": a request to create, change, fix, add or remove something in the app now, including short follow-ups like "make it blue" or "yes, do it".

Examples:
"hey there" → chat
"what can you build?" → chat
"how does Daedalus save my work?" → chat
"how do I deploy this?" → chat
"which file handles the login form?" → ask
"why does the list reset when I reload?" → ask
"a recipe app for my family" → plan
"add a dark mode toggle" → build
"make the header blue" → build

If a message could be a request to make or change something, it is not "chat". If the route you'd pick isn't in the allowed list, pick the closest allowed one. When unsure between the allowed routes, choose the one listed last.

Reply with exactly: {"route": "<route>", "reason": "<at most 12 words>"}`;

export function routerInput(input: { text: string; mode: Mode; lastAssistant?: string; hasWork: boolean; pendingPlan: boolean }): string {
  const lines = [
    `Allowed routes: ${ALLOWED[input.mode].map((r) => `"${r}"`).join(", ")} (the user is in ${input.mode === "plan" ? "Plan" : "Build"} mode).`,
    `Project: ${input.hasWork ? "has a built app" : "nothing built yet (starter app)"}${input.pendingPlan ? "; a proposed plan is waiting for the user" : ""}.`,
  ];
  if (input.lastAssistant) lines.push(`Daedalus's last reply (excerpt): ${input.lastAssistant.replace(/\s+/g, " ").slice(0, 400)}`);
  lines.push(`User's message: ${input.text.slice(0, 2000)}`);
  return lines.join("\n");
}

export const ROUTE_LABEL: Record<Route, string> = { chat: "Chat", ask: "Answer", plan: "Plan", build: "Build" };
