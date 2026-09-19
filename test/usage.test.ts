import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageAccumulator } from "../src/usage.js";

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

test("extracts input/cache tokens from message_start even with a nested cache_creation object", () => {
  // Real Anthropic responses nest a `cache_creation` object inside `usage`
  // - a naive `"usage"\s*:\s*(\{[^}]*\})` regex stops at that object's own
  // closing brace and produces an unparseable, truncated capture.
  const acc = new UsageAccumulator();
  acc.push(
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_1",
        usage: {
          input_tokens: 25,
          cache_creation_input_tokens: 3000,
          cache_read_input_tokens: 40000,
          cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 0 },
          output_tokens: 1,
        },
      },
    })
  );
  acc.push(sseEvent("message_delta", { type: "message_delta", usage: { output_tokens: 842 } }));
  acc.push(sseEvent("message_stop", { type: "message_stop" }));

  const usage = acc.finalize();
  assert.deepEqual(usage, {
    inputTokens: 25,
    outputTokens: 842,
    cacheCreationTokens: 3000,
    cacheReadTokens: 40000,
  });
});

test("handles the SSE event straddling multiple chunk boundaries", () => {
  const acc = new UsageAccumulator();
  const full = sseEvent("message_start", {
    type: "message_start",
    message: {
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 0 },
        output_tokens: 1,
      },
    },
  });
  // split mid-object, mid-line, to simulate arbitrary network chunking
  const splitPoints = [5, 40, full.length - 3];
  let offset = 0;
  for (const point of splitPoints) {
    acc.push(full.slice(offset, point));
    offset = point;
  }
  acc.push(full.slice(offset));

  const usage = acc.finalize();
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.cacheReadTokens, 500);
});

test("falls back to a single non-streaming JSON body", () => {
  const acc = new UsageAccumulator();
  acc.push(
    JSON.stringify({
      type: "message",
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 20000,
      },
    })
  );
  const usage = acc.finalize();
  assert.deepEqual(usage, {
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 20000,
  });
});

test("returns zeroed usage rather than throwing on an unparseable body", () => {
  const acc = new UsageAccumulator();
  acc.push("not json at all");
  const usage = acc.finalize();
  assert.deepEqual(usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
});

test("ignores an unparseable/truncated SSE event without losing later ones", () => {
  const acc = new UsageAccumulator();
  acc.push("event: message_start\ndata: {not valid json\n\n");
  acc.push(sseEvent("message_delta", { type: "message_delta", usage: { output_tokens: 12 } }));
  const usage = acc.finalize();
  assert.equal(usage.outputTokens, 12);
});
