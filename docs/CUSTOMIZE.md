# Customize: connections, skills, rules, memory and kits

The **Customize** tab in a project sets how Daedalus works on it. Everything uses open, portable formats (MCP servers, `SKILL.md` files in the repo, `AGENTS.md`), so nothing is locked in, and it works with any model you connect, not only Claude.

| Section | What it is | Where it lives | Enforced or requested |
| --- | --- | --- | --- |
| Connections | MCP servers whose tools the agent can call | `connections` table; tokens encrypted | Enforced: what's off or not read-only isn't offered |
| Skills | Playbooks loaded when a task matches | `SKILL.md` files in the repo, plus built-ins | Requested: the agent decides when to load one |
| Rules that always run | Commands and blocks the harness runs every time | `projects.settings.rules` | Enforced by the harness |
| Instructions & memory | Your preferences, and facts you chose to keep | `profiles.instructions`, `memories` table | Requested: loaded into every prompt |
| Kits | One-click bundles of the above | Installs into the sections above | — |

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

## Kits

| Kit | Installs |
| --- | --- |
| Docs research | Context7 and DeepWiki connections, and a `docs-first` skill |
| Quality | Tests must pass before finishing (when present), and changed files are formatted |
| Careful changes | Ask before adding packages; no recursive deletes |

Installing keeps whatever the project already has, and each part stays editable in its own section.

## Tests

- `node scripts/smoke-customize.mjs`: 35 checks with the scripted model. It covers:
  - skills: saving, loading, a switched-off skill being refused, deleting;
  - rules: a command being blocked, after-change output, a failed check followed by a passing one;
  - connections: real calls to Context7 and DeepWiki, read-only gating, refused addresses, tokens never returned;
  - memory: proposed memories staying out of the prompt, and kept ones and your instructions reaching it;
  - kits.
- `node scripts/smoke-customize-real.mjs` is the same flow on a real NIM model.
