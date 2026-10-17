import type { RulePreset } from "./rules";
import type { Skill } from "./skills/skill-file";

/**
 * Kits: one install that bundles skills, rules and connections. Installing writes the skills
 * into the project's repo, adds the rules and connects the services; each part can then be
 * changed or removed on its own in Customize.
 */
export interface Kit {
  id: string;
  name: string;
  description: string;
  skills: Skill[];
  rules: RulePreset[];
  connections: Array<{ name: string; url: string; readOnly: boolean }>;
}

export const KITS: Kit[] = [
  {
    id: "docs-research",
    name: "Docs research",
    description: "Looks up current documentation before using a library, so code matches today's APIs.",
    skills: [
      {
        name: "docs-first",
        description: "Check current docs before using a library or API you aren't sure about. Use whenever adding or changing code that calls a third-party package.",
        body: `# Docs first

1. Before writing code against a library you aren't certain about, look it up:
   - Context7: call resolve-library-id with the library's name, then query-docs with that id and a specific question.
   - DeepWiki: read_wiki_structure or ask_wiki_question for a public GitHub repository (owner/repo).
2. Prefer the version installed in package.json; mention it in your question.
3. Copy patterns from the docs, not from memory. If the docs and your memory disagree, the docs win.
4. If a lookup fails, say so and fall back to research.`,
      },
    ],
    rules: [],
    connections: [
      { name: "context7", url: "https://mcp.context7.com/mcp", readOnly: true },
      { name: "deepwiki", url: "https://mcp.deepwiki.com/mcp", readOnly: true },
    ],
  },
  {
    id: "quality",
    name: "Quality",
    description: "Tests must pass before a build finishes, and changed files are formatted.",
    skills: [],
    rules: [
      { event: "before_finish", label: "Tests pass (when the project has them)", command: "npm test --if-present" },
      { event: "after_change", label: "Format changed files", glob: "src/**/*.{ts,tsx,css}", command: "npx --yes prettier --write {file}" },
    ],
    connections: [],
  },
  {
    id: "careful",
    name: "Careful changes",
    description: "Asks before adding packages and never deletes folders recursively.",
    skills: [],
    rules: [
      { event: "before_command", label: "Ask before adding packages", pattern: "npm install", reason: "Ask the user before adding or reinstalling dependencies." },
      { event: "before_command", label: "No recursive deletes", pattern: "rm -rf *", reason: "Delete specific files with delete_file instead." },
    ],
    connections: [],
  },
];

export const kitById = (id: string) => KITS.find((k) => k.id === id);
