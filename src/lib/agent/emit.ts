import "server-only";
import type { UIMessageChunk } from "ai";
import { getWritable } from "workflow";

/** Writes one UI chunk to the run's durable stream. Only valid inside a workflow step. */
export async function emit(chunk: UIMessageChunk) {
  const writer = getWritable<UIMessageChunk>().getWriter();
  try {
    await writer.write(chunk);
  } finally {
    writer.releaseLock();
  }
}

/**
 * Asks the workspace to reload the preview it has open, so a check sees a fresh page load
 * (React reports each warning once per load). Transient: it isn't saved with the message.
 */
export function requestPreviewReload(checkId: string) {
  return emit({ type: "data-preview-reload", id: "preview-reload", data: { checkId }, transient: true });
}
