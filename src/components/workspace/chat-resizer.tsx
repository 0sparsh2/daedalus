"use client";
import { useRef } from "react";

export const CHAT_MIN = 320;
export const CHAT_DEFAULT = 440;
/** The panels keep at least this much room, so the preview stays usable. */
const PANEL_MIN = 420;

export function clampChatWidth(width: number, container: number): number {
  const max = Math.max(CHAT_MIN, container - PANEL_MIN);
  return Math.round(Math.min(max, Math.max(CHAT_MIN, width)));
}

/**
 * The divider between the chat and the panels: drag it, or focus it and use the arrow keys
 * (Shift for bigger steps, Home and End for the limits). Double-click puts it back.
 */
export function ChatResizer({
  width,
  container,
  onResize,
  onDone,
  onDragging,
}: {
  width: number;
  container: () => HTMLElement | null;
  onResize(width: number): void;
  onDone(width: number): void;
  onDragging(dragging: boolean): void;
}) {
  const drag = useRef<{ left: number; total: number; last: number } | null>(null);
  // Rendered on the server too, where there's no window yet.
  const total = () => container()?.getBoundingClientRect().width ?? (typeof window === "undefined" ? 1440 : window.innerWidth);
  const max = Math.max(CHAT_MIN, total() - PANEL_MIN);

  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the chat"
      aria-valuemin={CHAT_MIN}
      aria-valuemax={Math.round(max)}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const rect = container()?.getBoundingClientRect();
        drag.current = { left: rect?.left ?? 0, total: rect?.width ?? window.innerWidth, last: width };
        e.currentTarget.setPointerCapture(e.pointerId);
        onDragging(true);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.last = clampChatWidth(e.clientX - d.left, d.total);
        onResize(d.last);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        onDragging(false);
        if (d) onDone(d.last);
      }}
      onPointerCancel={() => {
        drag.current = null;
        onDragging(false);
      }}
      onDoubleClick={() => onDone(clampChatWidth(CHAT_DEFAULT, total()))}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 80 : 24;
        const next =
          e.key === "ArrowLeft" ? width - step : e.key === "ArrowRight" ? width + step : e.key === "Home" ? CHAT_MIN : e.key === "End" ? Number.POSITIVE_INFINITY : null;
        if (next === null) return;
        e.preventDefault();
        onDone(clampChatWidth(next, total()));
      }}
    />
  );
}
