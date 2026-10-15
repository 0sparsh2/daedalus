"use client";
import type { UIMessage } from "ai";
import { Icon } from "@/components/icons";
import { PlanCard, TodoList, type ToolPart } from "./tool-cards";

/** The latest plan the agent proposed and its current task list, in one place. */
export function PlanPanel({ messages, onStartBuild, running }: { messages: UIMessage[]; onStartBuild(): void; running: boolean }) {
  let plan: ToolPart | null = null;
  let todos: Array<{ content: string; status: string }> = [];
  for (const m of messages) {
    for (const p of m.parts as unknown as ToolPart[]) {
      if (p.type === "tool-propose_plan" && p.input) plan = p;
      if (p.type === "tool-update_todos" && Array.isArray(p.input?.todos)) todos = p.input.todos as typeof todos;
    }
  }
  if (!plan && todos.length === 0) {
    return (
      <div className="empty">
        <Icon name="list" size={22} />
        <b>No plan yet</b>
        <span>Use “Plan first” to agree on what to build. The agent&apos;s task list shows here while it works.</span>
      </div>
    );
  }
  const lastIsPlan = messages.length > 0 && (messages[messages.length - 1].parts as unknown as ToolPart[]).some((p) => p.type === "tool-propose_plan");
  return (
    <div style={{ padding: 16, display: "grid", gap: 14, alignContent: "start", maxWidth: 720 }}>
      {todos.length > 0 && <TodoList todos={todos} />}
      {plan && <PlanCard part={plan} canBuild={lastIsPlan && !running} onStartBuild={onStartBuild} onRequestChanges={() => document.getElementById("composer-input")?.focus()} />}
    </div>
  );
}
