import { test } from "node:test";
import assert from "node:assert/strict";
import { createConversationStore, getOrInitState, updateState } from "../src/conversationKey.js";

test("initializes state on first use and returns the same object on reuse", () => {
  const socket = {};
  const first = getOrInitState(socket, "sonnet");
  assert.equal(first.currentTier, "sonnet");
  assert.equal(first.turnsOnCurrentTier, 0);
  assert.equal(first.lastNewTokens, 0);
  assert.equal(first.lastOutputTokens, 0);
  const second = getOrInitState(socket, "haiku");
  assert.equal(second, first);
  assert.equal(second.currentTier, "sonnet");
});

test("two different sockets never share state, and each gets a distinct connectionId", () => {
  const a = getOrInitState({}, "sonnet");
  const b = getOrInitState({}, "sonnet");
  updateState(
    a,
    "haiku",
    { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
    [{ role: "user", content: "x" }]
  );
  assert.equal(a.currentTier, "haiku");
  assert.equal(b.currentTier, "sonnet");
  assert.notEqual(a.connectionId, b.connectionId);
});

test("updateState advances tier, turn count, prefix/new/output tokens, and tracked messages", () => {
  const state = getOrInitState({}, "sonnet");
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
  const state = getOrInitState({}, "sonnet");
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  updateState(state, "sonnet", usage, []);
  assert.equal(state.turnsOnCurrentTier, 1);
  updateState(state, "sonnet", usage, []);
  assert.equal(state.turnsOnCurrentTier, 2);
  updateState(state, "haiku", usage, []);
  assert.equal(state.turnsOnCurrentTier, 1);
});

test("the same first message is one conversation across sockets; cache_control does not matter", () => {
  const store = createConversationStore();
  const plain = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
  const marked = [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }];
  const a = store.getOrInitState({}, "sonnet", plain);
  const b = store.getOrInitState({}, "haiku", marked);
  assert.equal(a, b);
  assert.equal(b.currentTier, "sonnet");
});

test("a different first message is a different conversation, even on the same socket", () => {
  const store = createConversationStore();
  const socket = {};
  const a = store.getOrInitState(socket, "sonnet", [{ role: "user", content: "one" }]);
  const b = store.getOrInitState(socket, "sonnet", [{ role: "user", content: "two" }]);
  assert.notEqual(a, b);
  assert.notEqual(a.connectionId, b.connectionId);
});

test("with no messages it falls back to the socket", () => {
  const store = createConversationStore();
  const socket = {};
  assert.equal(store.getOrInitState(socket, "sonnet"), store.getOrInitState(socket, "opus"));
  assert.notEqual(store.getOrInitState({}, "sonnet"), store.getOrInitState({}, "sonnet"));
});

test("two stores never share a conversation", () => {
  const messages = [{ role: "user", content: "same" }];
  assert.notEqual(
    createConversationStore().getOrInitState({}, "sonnet", messages),
    createConversationStore().getOrInitState({}, "sonnet", messages)
  );
});
