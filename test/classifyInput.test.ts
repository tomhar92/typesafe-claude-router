import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLatestUserText, sanitizeForClassifier } from "../src/classifyInput.js";

test("keeps scanning back when the last user message is only tool results", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "fix the flaky retry test" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "file text" }] },
  ];
  assert.equal(extractLatestUserText(messages), "fix the flaky retry test");
});

test("joins every text block in a user message, not just the first", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
  ];
  assert.equal(extractLatestUserText(messages), "first\nsecond");
});

test("omits image blocks rather than shipping base64 to a third party", () => {
  const sanitized = sanitizeForClassifier([
    { role: "user", content: [{ type: "image", source: { type: "base64", data: "A".repeat(5000) } }] },
  ]) as any[];
  assert.deepEqual(sanitized[0].content[0], { type: "image", omitted: true });
});

test("truncates a long block and drops cache_control", () => {
  const sanitized = sanitizeForClassifier([
    { role: "user", cache_control: { type: "ephemeral" }, content: [{ type: "text", text: "x".repeat(5000) }] },
  ]) as any[];
  assert.equal("cache_control" in sanitized[0], false);
  assert.ok(sanitized[0].content[0].text.length < 2100);
  assert.ok(sanitized[0].content[0].text.endsWith("[truncated]"));
});

test("stops spending characters once the total budget is exhausted", () => {
  const big = { role: "user", content: [{ type: "text", text: "y".repeat(2000) }] };
  const sanitized = sanitizeForClassifier(Array.from({ length: 40 }, () => big));
  assert.ok(JSON.stringify(sanitized).length < 30_000);
});
