import { test } from "node:test";
import assert from "node:assert/strict";
import { conversationKeyFor, getOrInitState, updateState } from "../src/conversationKey.js";
import { stringifyWithoutCacheControl } from "../src/normalize.js";

const SESSION = {
  system: "You are Claude Code.",
  messages: [{ role: "user", content: "start the task" }, { role: "assistant", content: "ok" }],
};

let nextKey = 0;
/** A key no other test shares, since conversation state is process-global. */
function freshKey(): string {
  nextKey += 1;
  return conversationKeyFor({ system: `test-${nextKey}`, messages: [{ role: "user", content: "x" }] });
}

test("the key survives a reconnect and a growing history", () => {
  const first = conversationKeyFor(SESSION);
  const later = conversationKeyFor({
    ...SESSION,
    messages: [...SESSION.messages, { role: "user", content: "next" }],
  });
  assert.equal(first, later);
});

test("the key ignores a moved cache_control breakpoint", () => {
  const marked = {
    system: SESSION.system,
    messages: [{ role: "user", content: "start the task", cache_control: { type: "ephemeral" } }],
  };
  assert.equal(conversationKeyFor(SESSION), conversationKeyFor(marked));
});

test("different system prompts or first messages give different keys", () => {
  const base = conversationKeyFor(SESSION);
  assert.notEqual(base, conversationKeyFor({ ...SESSION, system: "Something else." }));
  assert.notEqual(
    base,
    conversationKeyFor({ ...SESSION, messages: [{ role: "user", content: "another task" }] })
  );
});

test("a body with no system or messages still yields a stable key", () => {
  assert.equal(conversationKeyFor({}), conversationKeyFor({ messages: "nope" }));
});

test("a background call gets its own state instead of corrupting the session's", () => {
  const session = getOrInitState(conversationKeyFor(SESSION), "opus");
  session.turnsOnCurrentTier = 7;

  const background = getOrInitState(
    conversationKeyFor({ system: "Summarize this conversation.", messages: [{ role: "user", content: "..." }] }),
    "haiku"
  );
  background.turnsOnCurrentTier = 1;

  assert.equal(getOrInitState(conversationKeyFor(SESSION), "opus").turnsOnCurrentTier, 7);
  assert.equal(getOrInitState(conversationKeyFor(SESSION), "opus").currentTier, "opus");
});

test("evicts a conversation that has gone quiet", () => {
  const key = conversationKeyFor({ system: "evict-me", messages: [{ role: "user", content: "y" }] });
  const state = getOrInitState(key, "sonnet", 0);
  state.turnsOnCurrentTier = 4;
  const later = getOrInitState(key, "sonnet", 7 * 60 * 60 * 1000);
  assert.equal(later.turnsOnCurrentTier, 0);
});

test("a conversation seen recently is not evicted", () => {
  const key = freshKey();
  const state = getOrInitState(key, "sonnet", 0);
  state.turnsOnCurrentTier = 4;
  assert.equal(getOrInitState(key, "sonnet", 60 * 60 * 1000).turnsOnCurrentTier, 4);
});

test("initializes state on first use and returns the same object on reuse", () => {
  const key = freshKey();
  const first = getOrInitState(key, "sonnet");
  assert.equal(first.currentTier, "sonnet");
  assert.equal(first.turnsOnCurrentTier, 0);
  assert.equal(first.lastNewTokens, 0);
  assert.equal(first.lastOutputTokens, 0);
  assert.equal(first.conversationId, key);
  const second = getOrInitState(key, "haiku");
  assert.equal(second, first);
  assert.equal(second.currentTier, "sonnet");
});

test("updateState advances tier, turn count, prefix/new/output tokens, and tracked messages", () => {
  const state = getOrInitState(freshKey(), "sonnet");
  const messages = [{ role: "user", content: "x" }, { role: "assistant", content: "y" }];
  updateState(
    state,
    "haiku",
    {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 1500,
    },
    messages
  );
  assert.equal(state.currentTier, "haiku");
  assert.equal(state.turnsOnCurrentTier, 1);
  assert.equal(state.lastPrefixTokens, 2000);
  assert.equal(state.lastNewTokens, 1000);
  assert.equal(state.lastOutputTokens, 500);
  assert.deepEqual(state.lastMessages, messages);
});

test("turnsOnCurrentTier accumulates while the tier stays the same and resets on a real change", () => {
  const state = getOrInitState(freshKey(), "sonnet");
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  updateState(state, "sonnet", usage, []);
  assert.equal(state.turnsOnCurrentTier, 1);
  updateState(state, "sonnet", usage, []);
  assert.equal(state.turnsOnCurrentTier, 2);
  updateState(state, "haiku", usage, []);
  assert.equal(state.turnsOnCurrentTier, 1);
});

test("stringifyWithoutCacheControl drops the marker at any depth and leaves the rest", () => {
  const value = {
    role: "user",
    cache_control: { type: "ephemeral" },
    content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
  };
  assert.equal(
    stringifyWithoutCacheControl(value),
    JSON.stringify({ role: "user", content: [{ type: "text", text: "hi" }] })
  );
});

test("stringifyWithoutCacheControl returns a string for undefined input", () => {
  assert.equal(stringifyWithoutCacheControl(undefined), "");
});
