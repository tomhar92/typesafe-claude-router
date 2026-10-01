import type { JsonValue } from "@typesafe-ai/sdk";

/** Per-string cap. Two thousand characters is far more than the
 * classifier needs to judge difficulty, and far less than a pasted file. */
const MAX_BLOCK_CHARS = 2000;
/** Whole-payload cap across the six messages we send. */
const MAX_TOTAL_CHARS = 24_000;

export function extractLatestUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown } | null;
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) continue;
    const text = message.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          Boolean(block) && block.type === "text" && typeof block.text === "string"
      )
      .map((block) => block.text)
      .join("\n");
    // Keep walking back when this user message carried no text at all. In
    // Claude Code's agentic loop the last `user` message is usually the
    // tool results from the previous assistant turn; returning "" there
    // left the classifier with no user signal on the majority of turns.
    if (text.length > 0) return text;
  }
  return "";
}

export function sanitizeForClassifier(messages: unknown[]): JsonValue[] {
  let budget = MAX_TOTAL_CHARS;

  const take = (value: unknown): JsonValue => {
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      return value as JsonValue;
    }
    if (typeof value === "string") {
      const allowance = Math.max(0, Math.min(MAX_BLOCK_CHARS, budget));
      const slice = value.slice(0, allowance);
      budget -= slice.length;
      return slice.length < value.length ? `${slice}…[truncated]` : slice;
    }
    if (Array.isArray(value)) return value.map(take);
    if (typeof value === "object") {
      const source = value as Record<string, unknown>;
      // An image block is megabytes of base64 that say nothing about
      // which tier the turn needs, and it is the single largest thing we
      // would otherwise hand to a third party.
      if (source.type === "image") return { type: "image", omitted: true };
      const out: Record<string, JsonValue> = {};
      for (const [key, nested] of Object.entries(source)) {
        // cache_control is a caching directive, not content; it also
        // moves turn to turn, which would make otherwise-identical
        // payloads differ.
        if (key === "cache_control") continue;
        out[key] = take(nested);
      }
      return out;
    }
    return null;
  };

  return messages.map(take);
}
