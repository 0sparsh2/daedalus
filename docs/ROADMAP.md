# Roadmap

What we plan to build next in Daedalus's agent harness, and why. Each item starts from something we can see in our own code, and its design comes from public sources, listed at the end. Platform work, such as the preview proxy, a GitHub App and more project types, is tracked in [ARCHITECTURE.md §13](ARCHITECTURE.md#13-decisions-alternatives-and-whats-next).

## Just shipped

| Feature | What it does | Details |
| --- | --- | --- |
| Mentions in the message box | `@` points at a file and `/` uses a skill; both load into that turn. A **+** menu opens connections and rules. | [CUSTOMIZE.md](CUSTOMIZE.md#from-the-message-box) |
| Content is data, not instructions | Every prompt that reads outside material, sub-agents included, says that text in files, pages, command output and connected services is material, never instructions. When a tool result contains text aimed at AI agents, the harness adds a reminder inside that result and flags the tool card. | `src/lib/agent/injection.ts`, `CONTENT_IS_DATA` in `prompts.ts` |
| The cheapest form for what the agent learns | The agent can suggest a **skill** (a procedure with a trigger) or a **rule** (something that must always happen), not only a memory. Each suggestion names the moment that showed it's needed, and nothing applies until you add it. | `src/lib/suggestions.ts`, [CUSTOMIZE.md](CUSTOMIZE.md#suggestions-and-reviews) |
| Review recent runs | A review turn reads the project's past runs on demand and suggests at most three changes, each tied to a run. It judges existing skills, rules and memories as helped, hurt, no visible effect or can't tell, and "no change" is a valid answer. | Customize → Improve, or `/review` |

The last three items follow [Harness²](https://github.com/google-research/harness2) (Google Research, Apache-2.0). It treats the harness as editable components with different costs: text that's always in the prompt costs the most, and skills, scripts and hooks cost less. It improves the harness from execution evidence and has no answer key to check against. We use its principles and write our own prompts.

## Now: safety and cost

### 1. Secret redaction in traces and memory
- **Why:** tool spans store each call's input and up to 1,500 characters of its output (`summarize` in `src/lib/agent/runtime.ts`). Model-call spans and memories aren't scrubbed either. A `cat .env` or a pasted key would land in Postgres as-is.
- **Approach:** add one `redact()` that runs before every span, message and memory write. It masks the value of a secret-looking key (`*_KEY`, `*_TOKEN`, `password`, `authorization`), plus common key formats (`sk-…`, `nvapi-…`, `ghp_…`, `AKIA…`, JWTs), keeping the first 4 characters so a trace stays readable.
- **Reference:** OWASP Logging Cheat Sheet; GitHub's published secret-scanning patterns.

### 2. Retention cleanup
- **Why:** spans, runs and messages are never deleted. Spans grow fastest: every model and tool call is one.
- **Approach:** a daily Vercel Cron job deletes spans older than `TRACE_RETENTION_DAYS` (default 30), keeping each run's totals and summary. Messages stay as long as their project does, because they are the user's chat. Old versions are pruned only when the user asks.
- **Reference:** Vercel Cron Jobs.

### 3. Per-tool permissions for connections
- **Why:** the only gate today is read-only or not, set from the server's `readOnlyHint` or the user's "only reads data" flag (`src/lib/mcp/connections.ts`). There's no way to allow one tool and turn off another.
- **Approach:** each tool gets **Allow**, **Ask** or **Off** in Customize → Connections. The default is Allow for read-only tools and Ask for everything else.
  - **Ask** ends the turn with an approval card, the same way `ask_user` does.
  - Approving runs the call and continues in the next turn.
  - Approvals can be "this time" or "always for this project".
- **Reference:** MCP tool annotations (`readOnlyHint`, `destructiveHint`); the allow/ask/deny permission rules in Claude Code's public documentation.

### 4. Sandbox network and environment limits
- **Why:** neither sandbox provider sets network limits (`src/lib/sandbox/docker.ts`, `vercel.ts`). The app's sandbox can reach any host.
- **Approach:**
  - **Network:** an allowlist by default: npm, GitHub, common CDNs and the app's declared APIs. The project can widen it in settings.
  - **Environment:** the sandbox gets only the variables the app needs, never Daedalus's own.
- **Reference:** Vercel Sandbox network policy documentation; Docker network options for local dev.

## Next: agent quality

### 5. Hints for known errors
- **Why:** the same build errors recur across runs, for example a missing import, an uninstalled package or a Tailwind v4 class that changed. Each time, the model has to work out the cause from scratch.
- **Approach:** a small table matches an error signature to a one-line hint, appended to the tool result. For example, Vite's "Failed to resolve import" gets "the package isn't installed, or the path is wrong". Harness² names this as one of the jobs a hook does better than prompt text. We already do its other three:
  - trimming oversized output (`truncateMiddle`);
  - stopping runaway tools (the loop guard);
  - checking a write straight after it happens (after-change rules).
- **Reference:** Harness² `plugin` component guidance.

### 6. Skill listing that scales with the model
- **Why:** `listProjectSkills` reads a fixed 4 KB per skill file, whatever the model's context window (`src/lib/skills/project.ts`).
- **Approach:** give the skill index a budget relative to the context window. Shorten long descriptions first, then drop skills that haven't been used recently, and say how many were left out.

### 7. Evals that read runs as a set
- **Why:** golden-task evals ran each task twice. A failure seen once in two runs can't be told apart from noise.
- **Approach:**
  - Run each golden task at least 3 times and fix only failures that repeat.
  - Later, an offline tuning loop in the style of Harness² proposes edits to our built-in skills and prompts, tests each one on the evals, and keeps what the evidence supports. This is a developer tool, not a product feature: Harness² spends 4 or more runs per task.
- **Reference:** Harness² Propose–Probe–Compose and its guidance on weighing evidence.

### 8. Context gauge, fuller token accounting, rate limits
- **Why:**
  - Run totals count input and output tokens (`add_run_usage`). Each model-call span already records cached input tokens, but nothing adds them up.
  - The gateway sees a provider's 429 and `retry-after`, but the user only sees a slower run.
- **Approach:**
  - Add cached tokens to run totals.
  - Show how full the context window is in the Trace tab.
  - Stream a "waiting for the provider's rate limit (Ns)" status when the gateway backs off.
- **Reference:** AI SDK usage fields; provider rate-limit headers.

### 9. Check skills' file references on save
- **Approach:** when a skill is saved or suggested, reject it if its instructions point at a script or file that doesn't exist in its folder. Harness² throws out whole proposals for this mistake, because a skill that calls a missing script fails every time it's used.

## Later: product

### 10. Signing in to connections (OAuth)
Connections take an optional token today. Many hosted MCP servers expect OAuth instead. We'd implement the MCP authorization flow: OAuth 2.1 with PKCE, metadata discovery and dynamic client registration. Tokens would be encrypted the same way as today. *Reference: the MCP specification, Authorization.*

### 11. Custom sub-agents
Only `research` and `explore` exist, and they're defined in code. Projects could define their own in `.agents/agents/<name>.md`, giving a description, a model, a tool set and instructions. The UI would explain when one is worth it, using Harness²'s rule of thumb: a sub-agent pays off when its input is large and its answer is small. *Reference: OpenCode's agent configuration; Harness² sub-agents.*

### 12. Scheduled and background runs
For example, "every Monday, update the dependencies and tell me what changed". The schedule's tools are fixed when it's created: reading, editing project files and running checks. Deploys, pushes and connection calls that aren't read-only are refused and reported, never attempted. The run ends with a summary in the chat. Plan turns never run unattended. *Reference: Vercel Workflow and Cron Jobs.*

### 13. Undo a single change
Versions are per run (git checkpoints). Each file-edit card could get **Undo this change**, restoring that file's state from before the call, from git, as a new commit, so undoing is itself undoable.

### 14. Editable memories and more rule triggers
- **Memories:** you can only keep or forget a memory. You should be able to edit one too.
- **Rule triggers:** rules run before finishing, before a command and after a change. Two more would help: **when a run starts** (for example, `npm install` when the lockfile changed) and **before shipping** (tests must pass before a deploy or push).

### 15. OpenTelemetry export
Our spans are already a tree of runs, model calls, tool calls and sub-agents. Mapping them to the OpenTelemetry semantic conventions for generative AI would let teams send traces to the observability tools they already use. *Reference: OpenTelemetry semantic conventions for GenAI.*

### 16. "While you were away"
When a run finishes after you've left, show a short summary the next time you open the project: what changed, the checks, anything it asked. `runs.summary` already holds the run's last reply.

## Sources

Everything here comes from our own code and public material:

- Harness²: Recursive Agent Harnessing for an Open World. Google Research, Apache-2.0. [Code](https://github.com/google-research/harness2), [paper](https://arxiv.org/abs/2610.14224).
- Model Context Protocol specification: tool annotations and authorization. https://modelcontextprotocol.io
- Claude Code public documentation: hooks, permissions, skills, sub-agents. https://docs.claude.com
- OpenCode (open source): https://github.com/sst/opencode
- OpenAI Codex CLI (open source): https://github.com/openai/codex
- OpenTelemetry semantic conventions for generative AI: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Vercel Sandbox, Workflow and Cron Jobs documentation: https://vercel.com/docs
- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org

We don't use leaked or reverse-engineered material from proprietary products.
