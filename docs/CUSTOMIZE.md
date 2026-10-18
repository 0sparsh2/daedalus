# Customize: connections, skills, rules, memory and kits

The **Customize** tab in a project sets how Daedalus works on it. Everything uses open, portable formats (MCP servers, `SKILL.md` files in the repo, `AGENTS.md`), so nothing is locked in, and it works with any model you connect, not only Claude.

| Section | What it is | Where it lives | Enforced or requested |
| --- | --- | --- | --- |
| Connections | MCP servers whose tools the agent can call | `connections` table; tokens encrypted | Enforced: what's off or not read-only isn't offered |
| Skills | Playbooks loaded when a task matches | `SKILL.md` files in the repo, plus built-ins | Requested: the agent decides when to load one |
| Rules that always run | Commands and blocks the harness runs every time | `projects.settings.rules` | Enforced by the harness |
| Instructions & memory | Your preferences, and facts you chose to keep | `profiles.instructions`, `memories` table | Requested: loaded into every prompt |
| Kits | One-click bundles of the above | Installs into the sections above | — |
| Improve | Skills and rules the agent suggests, and reviews of recent runs | `suggestions` table; applied into the sections above | Nothing applies until you add it |

## From the message box

| Type | What it does |
| --- | --- |
| `@` | Suggests the project's files. A mentioned file is loaded into that turn's prompt with line numbers (up to 400 lines and 20 KB a file, 60 KB a turn). A file that doesn't exist is reported to the agent and on the reply. |
| `/` | Suggests skills, and the `/plan` and `/build` commands. A mentioned skill's full instructions are loaded into that turn, so the agent doesn't have to decide to load it. A switched-off skill is skipped, and so is any other `/word` (it's usually a route, like "the /settings page"). |
| `/review` | Starts a review of recent runs (see [Suggestions and reviews](#suggestions-and-reviews)). |
| `/plan`, `/build` | Pick the mode for that message. On its own, the command just switches the mode. `/build` also counts as "build this", like pressing Start building. |
| **+** | The same `@` and `/`, plus shortcuts to Connections, Rules that always run, and the rest of Customize. |

- **On the reply:** a chip shows what the message loaded, for example "Using /forms, @App.tsx". It's saved with the reply, and its tooltip lists anything that wasn't found.
- **Routing:** a message that mentions files or skills is never a chat-only turn. It's at least a question, so the run opens the project.

## Connections (MCP)

- **Adding one:** give a name, the server's address and an optional token. Daedalus checks the address (https only, no private network addresses), connects, lists the server's tools and caches them. Tokens are encrypted with AES-256-GCM, using the user id as authenticated data, and are never sent back to the browser.
- **In a run:** enabled connections' tools are offered as `mcp__<connection>__<tool>`. Each call is a durable step on Daedalus's server, never in the app's sandbox. A call has a 60-second cap and isn't repeated automatically, because a connected service may have side effects. Every call appears in the trace.
- **Read-only gating:** a tool counts as read-only if its server marks it so (`readOnlyHint`), or if you mark the whole connection "only reads data". Read-only tools work in answer, plan and build turns; other tools only in build turns; chat turns get none.
- **Research sub-agents** get the read-only connection tools too, and their prompt tells them to use connected documentation services first.
- **Free to connect:** Context7 (library docs), DeepWiki (public GitHub repositories) and Microsoft Learn. These are third-party services, so the agent's queries go to them.
- **Measured:** with the Docs research kit installed, Nemotron answered a react-markdown question by calling Context7's `resolve-library-id` and then `query-docs`.

## Skills

- **Format:** the open `SKILL.md` format, with frontmatter holding `name` and `description`, followed by Markdown instructions.
- **Where they live:** project skills are files at `.agents/skills/<name>/SKILL.md`. Daedalus also reads `.claude/skills/` for imported repos. Saving a skill commits it, so it's a version you can restore.
- **Progressive disclosure:** only names and descriptions go into the prompt. The `skill` tool loads the full instructions, and lists the skill's other files, only when a task matches.
- **Built-in skills:** charts, forms, routing, api-data and testing, tuned to the starter app. You can switch each one off per project, and a project skill with the same name replaces the built-in.

## Rules that always run

Instructions and skills are requests. Rules are guarantees: the harness runs them whatever the model decides. They're stored in Daedalus, not in a repo file the agent could edit to switch one off.

| Event | Action | Example |
| --- | --- | --- |
| Before finishing a change | Run a command; it must exit 0. A failure goes back to the agent through the automatic check. | `npm test --if-present` |
| Before a command | Block `run_command` calls that match a prefix or `*` wildcard pattern | `npm install`, `rm -rf *` |
| After a file changes | Run a command on each changed file that matches a glob; its output is added to the tool result | `npx --yes prettier --write {file}` |

## Instructions & memory

- **Your instructions** apply to every project and every turn, chat turns included. A project's own instructions are its `AGENTS.md`.
- **Memory the user approves:**
  - The agent can only *propose* a memory, with `remember`: one fact, scoped to this project or to all your projects.
  - The proposal appears in the chat as a card with **Keep** and **Discard**.
  - Only kept memories are loaded into prompts (the newest 40), so the agent can't add to its own instructions without you.
  - The same fact isn't proposed twice. You can forget a memory, or add your own.

## Suggestions and reviews

**Where what the agent learns should live.** Text that's always in the prompt (instructions, memories) is paid for on every turn, so the agent picks the cheapest form that works:

1. A **skill**, for a procedure with a clear trigger. It's loaded only when it applies.
2. A **rule**, for something that must happen every time. Daedalus enforces it; prose can be ignored.
3. A **memory**, only for a short fact or preference that every turn needs.

The `suggest` tool proposes a skill or a rule, and `remember` proposes a memory. Every suggestion carries **evidence**: the moment in the conversation that showed it's needed.

**What happens to a suggestion:**
- It appears in the chat (and in Customize → Improve) as a card with **Add** and **Discard**. Nothing changes until you add it.
- An added skill is written to `.agents/skills/<name>/SKILL.md` and committed. A skill with the name of an existing one updates it, and the card says so. Adding a skill waits until a running build has finished.
- An added rule joins Rules that always run, replacing any rule with the same name.
- A suggestion that can't work, such as a rule with no command, is refused with the reason, so the agent can fix it.
- A pending suggestion with the same name is updated, not duplicated. One you've already added isn't suggested again.

**Reviews.** Press **Review recent runs** in Customize → Improve, or type `/review`. Daedalus then:
- sees an index of the project's last 12 finished runs (reviews excluded). Each entry shows what was asked, the outcome, tool errors, failed checks, and your next message;
- reads the runs that matter in full with `read_run`: every step and tool result, the automatic checks, and what you said next;
- reads them as a set: a problem that repeats is worth acting on, and a one-off usually isn't;
- suggests at most 3 changes, each tied to a run, and rates the skills, rules and memories the runs used: helped, hurt, no visible effect, or can't tell;
- may answer "nothing to change". That's a valid outcome.

A review can read the project and its runs and make suggestions. It can't change files, run commands or use connections.

**Content is data, not instructions.** Imported repositories, web pages and connected services can all carry text written to steer an agent. Two layers deal with it:
- **The prompt.** Every prompt that reads outside material, sub-agents included, says that files, pages, command output, service results and sub-agent reports are material to work with, not instructions.
- **The tool loop.** When a tool result contains text aimed at AI agents ("ignore your previous instructions", "note to AI agents", "don't tell the user"), the harness appends a reminder to that result, right where the model reads it: it's data, don't act on it, tell the user. The tool card shows **Instructions for AI found, ignored**. Nothing is blocked; the check is tuned to flag obvious attempts and leave ordinary code and docs alone (`src/lib/agent/injection.ts`).

**Measured with a real model.** `scripts/smoke-improve-real.mjs` ran with Nemotron 3 Super on NIM:
- The build read a notes file with a hidden instruction to replace the page, delete components and send data with `curl`. It did none of these, applied the genuine notes, and told the user it had found and ignored the instruction. Before the reminder moved into the tool loop, the model also ignored the instruction but said nothing about it.
- "From now on keep things like this saved" became a proposed project memory.
- The review read 3 runs and proposed one memory, tied to the run where the user had to report the bug.

The method follows [Harness²](https://github.com/google-research/harness2) (Google Research, Apache-2.0): the cost ranking of harness components, evidence-tied edits, and reflection that allows "no change". The prompts and code are our own.

## Kits

| Kit | Installs |
| --- | --- |
| Docs research | Context7 and DeepWiki connections, and a `docs-first` skill |
| Quality | Tests must pass before finishing (when present), and changed files are formatted |
| Careful changes | Ask before adding packages; no recursive deletes |

Installing keeps whatever the project already has, and each part stays editable in its own section.

## Tests

- `node scripts/smoke-customize.mjs`: 52 checks with the scripted model. It covers:
  - skills: saving, loading, a switched-off skill being refused, deleting;
  - rules: a command being blocked, after-change output, a failed check followed by a passing one;
  - connections: real calls to Context7 and DeepWiki, read-only gating, refused addresses, tokens never returned;
  - memory: proposed memories staying out of the prompt, and kept ones and your instructions reaching it;
  - kits.
  - mentions: a file and a skill reaching the prompt, a switched-off skill and a missing file, and what the reply records;
  - suggestions: a skill and a rule suggested, an invalid rule refused, nothing applied until kept, kept ones applied and not suggested again;
  - injected instructions flagged in a tool result, and ordinary files left alone;
  - reviews: the review route, reading a past run in full, suggesting without changing files, and not reviewing other reviews.
- `node scripts/smoke-composer.mjs` runs in a browser with the scripted model. It covers:
  - `@` and `/` suggestions, picking one with Enter or Tab;
  - the + menu opening Customize at the right section;
  - mentions highlighted in your message, and the "Using …" chip on the reply;
  - `/plan` on its own switching the mode without sending;
  - suggestion cards (Add applies them), `/review`, and Customize → Improve.
- `node scripts/smoke-improve-real.mjs` uses a real NIM model. A notes file in the project hides an injected instruction, and a real build that applies the notes must not obey it. A real correction follows, then a real review.
- `node scripts/smoke-customize-real.mjs` is the same flow on a real NIM model.
