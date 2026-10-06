import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractLatestUserText,
  isSideRequest,
  isToolResultContinuation,
  sanitizeForClassifier,
} from "../src/classifyInput.js";

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

const TOOL_USE = { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Read", input: {} }] };
const TOOL_RESULT = { type: "tool_result", tool_use_id: "1", content: "file text" };

test("a user message of only tool results continues the turn", () => {
  const messages = [{ role: "user", content: "fix it" }, TOOL_USE, { role: "user", content: [TOOL_RESULT] }];
  assert.equal(isToolResultContinuation(messages), true);
});

test("text next to tool results (reminders, skill bodies) does not make it a new user turn", () => {
  const messages = [
    TOOL_USE,
    {
      role: "user",
      content: [
        TOOL_RESULT,
        { type: "text", text: "<system-reminder>\nnote\n</system-reminder>" },
        { type: "text", text: "Base directory for this skill: /x" },
      ],
    },
  ];
  assert.equal(isToolResultContinuation(messages), true);
});

test("a plain user prompt is not a continuation", () => {
  assert.equal(isToolResultContinuation([{ role: "user", content: "hi" }]), false);
  assert.equal(isToolResultContinuation([{ role: "user", content: [{ type: "text", text: "hi" }] }]), false);
});

test("an empty or assistant-last request is not a continuation", () => {
  assert.equal(isToolResultContinuation([]), false);
  assert.equal(isToolResultContinuation([{ role: "assistant", content: "hi" }]), false);
});

test("a request with no tools is a side request; one with tools is not", () => {
  assert.equal(isSideRequest({}), true);
  assert.equal(isSideRequest({ tools: [] }), true);
  assert.equal(isSideRequest({ tools: [{ name: "Read" }] }), false);
});
