import { test } from "node:test";
import assert from "node:assert/strict";
import { adaptBetaHeader, adaptBodyForTier } from "../src/adaptRequest.js";

const text = (t: string) => ({ type: "text", text: t });

test("only a tier with a profile is reshaped", () => {
  const body: any = { max_tokens: 128000, thinking: { type: "adaptive" }, output_config: {}, messages: [] };
  adaptBodyForTier(body, "opus");
  assert.equal(body.max_tokens, 128000);
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.ok("output_config" in body);
});

test("a smaller max_tokens is kept, and an enabled budget is held under it", () => {
  const body: any = { max_tokens: 8000, thinking: { type: "enabled", budget_tokens: 20000 }, messages: [] };
  adaptBodyForTier(body, "haiku");
  assert.equal(body.max_tokens, 8000);
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 7999 });
});

test("a request with no thinking gets none added", () => {
  const body: any = { max_tokens: 128000, messages: [] };
  adaptBodyForTier(body, "haiku");
  assert.equal("thinking" in body, false);
});

test("a system message after a user turn is appended to it as a system-reminder", () => {
  const body: any = {
    messages: [{ role: "user", content: [text("a")] }, { role: "system", content: [text("note")] }],
  };
  adaptBodyForTier(body, "haiku");
  assert.deepEqual(body.messages, [
    { role: "user", content: [text("a"), text("<system-reminder>\nnote\n</system-reminder>")] },
  ]);
});

test("a system message in the middle folds into the preceding user turn and keeps alternation", () => {
  const body: any = {
    messages: [
      { role: "user", content: "q1" },
      { role: "system", content: "s1" },
      { role: "assistant", content: [text("a1")] },
      { role: "user", content: [text("q2")] },
    ],
  };
  adaptBodyForTier(body, "haiku");
  assert.deepEqual(body.messages.map((m: any) => m.role), ["user", "assistant", "user"]);
  assert.equal(body.messages[0].content.length, 2);
});

test("a leading system message is carried onto the next user turn", () => {
  const body: any = {
    messages: [{ role: "system", content: "first" }, { role: "user", content: [text("hi")] }],
  };
  adaptBodyForTier(body, "haiku");
  assert.deepEqual(body.messages.map((m: any) => m.role), ["user"]);
  assert.match(body.messages[0].content[0].text, /first/);
  assert.deepEqual(body.messages[0].content[1], text("hi"));
});

test("folding is deterministic, so the rewritten prefix is identical on the next turn", () => {
  const make = () => ({
    messages: [{ role: "user", content: [text("a")] }, { role: "system", content: [text("n")] }],
  });
  const one: any = make();
  const two: any = make();
  adaptBodyForTier(one, "haiku");
  adaptBodyForTier(two, "haiku");
  assert.deepEqual(one, two);
});

test("beta flags the tier rejects are removed; the rest are kept in order", () => {
  assert.equal(
    adaptBetaHeader("a-1,mid-conversation-system-2026-04-07, effort-2025-11-24 ,b-2", "haiku"),
    "a-1,b-2"
  );
  assert.equal(adaptBetaHeader("effort-2025-11-24", "haiku"), null);
  assert.equal(adaptBetaHeader("effort-2025-11-24", "sonnet"), "effort-2025-11-24");
});
