"use client";
import { useEffect, useRef } from "react";
import { Icon } from "@/components/icons";
import { ModelPicker } from "@/components/model-picker";

export type RunMode = "plan" | "build";

export function Composer(props: {
  value: string;
  onChange(v: string): void;
  onSubmit(): void;
  mode: RunMode;
  onModeChange(m: RunMode): void;
  running?: boolean;
  onStop?(): void;
  placeholder?: string;
  compact?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (props.autoFocus) ref.current?.focus();
  }, [props.autoFocus]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [props.value]);

  const canSend = props.value.trim().length > 0 && !props.disabled && !props.running;
  return (
    <form
      className={`composer${props.compact ? " compact" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) props.onSubmit();
      }}
    >
      <label className="sr-only" htmlFor="composer-input">
        {props.label ?? "Describe what you want to build"}
      </label>
      <textarea
        id="composer-input"
        ref={ref}
        rows={props.compact ? 2 : 3}
        value={props.value}
        placeholder={props.placeholder ?? "Describe what you want to build…"}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend) props.onSubmit();
          }
        }}
        disabled={props.disabled}
      />
      <div className="composer-row">
        <div className="mode" role="group" aria-label="Run mode">
          <button type="button" aria-pressed={props.mode === "plan"} onClick={() => props.onModeChange("plan")} title="Agree on a plan before anything is built">
            Plan first
          </button>
          <button type="button" aria-pressed={props.mode === "build"} onClick={() => props.onModeChange("build")} title="Start building straight away">
            Build
          </button>
        </div>
        <ModelPicker compact={props.compact} />
        <span className="spacer" />
        {props.running ? (
          <button type="button" className="send stop" onClick={props.onStop} aria-label="Stop the run" title="Stop">
            <Icon name="stop" size={16} />
          </button>
        ) : (
          <button type="submit" className="send" disabled={!canSend} aria-label="Send" title="Send (Enter)">
            <Icon name="arrowup" size={18} />
          </button>
        )}
      </div>
    </form>
  );
}
