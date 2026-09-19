export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

function applyUsageObject(totals: UsageTotals, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  if (typeof u.input_tokens === "number") totals.inputTokens = u.input_tokens;
  if (typeof u.output_tokens === "number") totals.outputTokens = u.output_tokens;
  if (typeof u.cache_creation_input_tokens === "number") {
    totals.cacheCreationTokens = u.cache_creation_input_tokens;
  }
  if (typeof u.cache_read_input_tokens === "number") {
    totals.cacheReadTokens = u.cache_read_input_tokens;
  }
}

/**
 * Incremental extractor for the `usage` totals on an Anthropic
 * `/v1/messages` response.
 *
 * A regex scan for `"usage"\s*:\s*(\{[^}]*\})` breaks the moment `usage`
 * contains a nested object — which it does in practice, via
 * `cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }`
 * - because the `[^}]*` stops at the *inner* closing brace, leaving the
 * captured text truncated and unparseable. That failure was silently
 * swallowed, so every real (non-test) response logged all-zero usage.
 *
 * This instead parses real SSE framing (`message_start` carries the
 * input/cache token counts, `message_delta` carries the running/final
 * `output_tokens`) while still handling a single non-streaming JSON body
 * for callers that don't stream.
 */
export class UsageAccumulator {
  private totals = emptyUsage();
  private mode: "unknown" | "sse" | "json" = "unknown";
  private buffer = "";

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.mode === "unknown") {
      const trimmed = this.buffer.trimStart();
      if (trimmed.length === 0) return;
      // Decide from the first non-whitespace character alone, not a
      // multi-char prefix like "event:" - that prefix can itself arrive
      // split across two chunks (e.g. "event" then ": message_start..."),
      // which would otherwise misdetect it as JSON and never recover.
      this.mode = trimmed[0] === "{" || trimmed[0] === "[" ? "json" : "sse";
    }
    if (this.mode === "sse") this.drainSseEvents();
  }

  private drainSseEvents(): void {
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      this.consumeSseEvent(rawEvent);
    }
  }

  private consumeSseEvent(rawEvent: string): void {
    const dataLines = rawEvent
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim());
    if (dataLines.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLines.join(""));
    } catch {
      return; // malformed/truncated event; nothing usable to extract
    }
    if (parsed === null || typeof parsed !== "object") return;
    const event = parsed as Record<string, unknown>;

    if (event.type === "message_start") {
      const message = event.message as Record<string, unknown> | undefined;
      applyUsageObject(this.totals, message?.usage);
    } else if (event.type === "message_delta") {
      applyUsageObject(this.totals, event.usage);
    }
  }

  /** Call once the full response body has been read. */
  finalize(): UsageTotals {
    if (this.mode === "json") {
      try {
        const parsed = JSON.parse(this.buffer) as Record<string, unknown>;
        applyUsageObject(this.totals, parsed.usage);
      } catch {
        // not parseable JSON either; leave totals as accumulated (zeros)
      }
    }
    return this.totals;
  }
}
