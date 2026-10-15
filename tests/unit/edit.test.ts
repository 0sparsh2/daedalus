import { describe, expect, it } from "vitest";
import { applyEdit, miniDiff } from "@/lib/agent/edit";

const file = `import React from "react";

export function App() {
  const title = "Hello";
  return (
    <div>
      <h1>{title}</h1>
    </div>
  );
}
`;

describe("applyEdit", () => {
  it("replaces an exact unique match", () => {
    const r = applyEdit(file, 'const title = "Hello";', 'const title = "Hi";');
    expect(r.ok && r.tier).toBe("exact");
    expect(r.ok && r.content).toContain('const title = "Hi";');
  });

  it("rejects ambiguous matches unless replaceAll", () => {
    const src = "a();\na();\n";
    const r = applyEdit(src, "a();", "b();");
    expect(r.ok).toBe(false);
    const all = applyEdit(src, "a();", "b();", true);
    expect(all.ok && all.content).toBe("b();\nb();\n");
  });

  it("folds typographic quotes", () => {
    const r = applyEdit(file, "const title = “Hello”;", 'const title = "Yo";');
    expect(r.ok && r.tier).toBe("unicode");
  });

  it("ignores trailing whitespace per line", () => {
    const r = applyEdit(file, "    <div>   \n      <h1>{title}</h1>  ", "    <section>\n      <h1>{title}</h1>");
    expect(r.ok && r.tier).toBe("trim-end");
    expect(r.ok && r.content).toContain("<section>");
  });

  it("re-indents when the model quoted with different indentation", () => {
    const r = applyEdit(file, "<div>\n  <h1>{title}</h1>\n</div>", "<main>\n  <h1>{title}</h1>\n  <p>new</p>\n</main>");
    expect(r.ok && r.tier).toBe("indentation");
    expect(r.ok && r.content).toContain("    <main>\n      <h1>{title}</h1>\n      <p>new</p>\n    </main>");
  });

  it("preserves CRLF line endings", () => {
    const crlf = file.replace(/\n/g, "\r\n");
    const r = applyEdit(crlf, 'const title = "Hello";\n  return (', 'const title = "X";\n  return (');
    expect(r.ok && r.content.includes("\r\n")).toBe(true);
    expect(r.ok && r.content).toContain('const title = "X";\r\n  return (');
  });

  it("explains a miss", () => {
    const r = applyEdit(file, "does not exist", "x");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/not found/);
  });

  it("refuses no-op edits", () => {
    expect(applyEdit(file, "App", "App").ok).toBe(false);
  });
});

describe("miniDiff", () => {
  it("counts added and removed lines", () => {
    const d = miniDiff("a\nb\nc\n", "a\nB\nc\nd\n");
    expect(d.removed).toBe(1);
    expect(d.added).toBe(2);
    expect(d.diff).toContain("- b");
    expect(d.diff).toContain("+ B");
  });
});
