// The router can only talk to the user through the response it relays, so a
// suggestion is added there as one extra text block, appended after what the
// model wrote. The request is left alone (no cache perturbation) and the
// message does not depend on the model choosing to repeat it.
//
// Only a turn that ends normally gets it. A response that stops to call a
// tool is mid-loop, and text after a tool_use block is not a place to put a
// notice; the next turn re-evaluates and suggests again if it still applies.

function isEndTurn(delta: unknown): boolean {
  return (
    typeof delta === "object" &&
    delta !== null &&
    (delta as { stop_reason?: unknown }).stop_reason === "end_turn"
  );
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Relays an Anthropic SSE stream event by event, adding `text` as a final
 * text block just before the closing `message_delta` of an end_turn reply. */
export class SseNoteInjector {
  private buffer = "";
  private nextIndex = 0;
  private injected = false;

  constructor(private readonly text: string) {}

  push(chunk: string): string {
    this.buffer += chunk;
    let out = "";
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = this.buffer.slice(0, boundary + 2);
      this.buffer = this.buffer.slice(boundary + 2);
      out += this.relay(rawEvent);
    }
    return out;
  }

  /** Whatever was left unterminated, passed through untouched. */
  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }

  private relay(rawEvent: string): string {
    const data = rawEvent
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("");
    let parsed: { type?: unknown; index?: unknown; delta?: unknown } | undefined;
    try {
      parsed = data ? JSON.parse(data) : undefined;
    } catch {
      return rawEvent;
    }
    if (parsed?.type === "content_block_start" && typeof parsed.index === "number") {
      this.nextIndex = Math.max(this.nextIndex, parsed.index + 1);
    }
    if (parsed?.type === "message_delta" && !this.injected && isEndTurn(parsed.delta)) {
      this.injected = true;
      const index = this.nextIndex;
      return (
        sse("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }) +
        sse("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: this.text },
        }) +
        sse("content_block_stop", { type: "content_block_stop", index }) +
        rawEvent
      );
    }
    return rawEvent;
  }
}

/** The non-streaming equivalent: append a text block to the reply's content. */
export function injectNoteIntoJson(body: string, text: string): string {
  try {
    const parsed = JSON.parse(body) as { content?: unknown; stop_reason?: unknown };
    if (!Array.isArray(parsed.content) || parsed.stop_reason !== "end_turn") return body;
    parsed.content.push({ type: "text", text });
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}
