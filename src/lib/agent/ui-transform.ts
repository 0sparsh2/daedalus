import { toUIMessageChunk, type ModelCallStreamPart } from "@ai-sdk/workflow";
import type { UIMessageChunk } from "ai";

/**
 * Converts the durable run stream (raw model-call parts plus the `data-*` chunks our steps
 * write) into AI SDK UI message chunks. Unlike the stock transform it keeps data chunks
 * (sub-agent progress, sandbox status, checks, checkpoints) and pins the assistant message id,
 * so the live message and the persisted one are the same message.
 * `uiStartIndex` skips chunks a reconnecting client already has.
 */
export function createUITransform({
  uiStartIndex = 0,
  messageId,
  metadata,
}: { uiStartIndex?: number; messageId?: string; metadata?: Record<string, unknown> } = {}) {
  let index = 0;
  const enqueue = (controller: TransformStreamDefaultController<UIMessageChunk>, chunk: UIMessageChunk) => {
    if (index++ >= uiStartIndex) controller.enqueue(chunk);
  };
  return new TransformStream<ModelCallStreamPart | UIMessageChunk, UIMessageChunk>({
    start(controller) {
      enqueue(controller, { type: "start", ...(messageId ? { messageId } : {}), ...(metadata ? { messageMetadata: metadata } : {}) });
      enqueue(controller, { type: "start-step" });
    },
    flush(controller) {
      enqueue(controller, { type: "finish-step" });
      enqueue(controller, { type: "finish" });
    },
    transform(part, controller) {
      if (part.type === "message-metadata") {
        enqueue(controller, part as UIMessageChunk);
        return;
      }
      if (typeof part.type === "string" && part.type.startsWith("data-")) {
        enqueue(controller, part as UIMessageChunk);
        return;
      }
      const ui = toUIMessageChunk(part as ModelCallStreamPart);
      // A model-stream error ends the round, and the run always closes with a `data-run-end`
      // note that says why (stopped, timed out, failed). Forwarding the raw error chunk would
      // make the client abandon the stream before that note and the saved version arrive.
      if (ui?.type === "error") return;
      if (ui) enqueue(controller, ui);
    },
  });
}
