import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/policy.js";
import { DEFAULT_PRICING } from "../src/pricing.js";
import type { ConversationState, ClassifyResult } from "../src/types.js";

function state(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    currentTier: "sonnet",
    turnsOnCurrentTier: 5,
    lastPrefixTokens: 20_000,
    lastNewTokens: 1_000,
    lastOutputTokens: 500,
    lastMessageCount: 2,
    lastMessages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }],
    ...overrides,
  };
}

const currentMessages = [
  { role: "user", content: "a" },
  { role: "assistant", content: "b" },
  { role: "user", content: "c" },
];

test("holds when neither margin clears the threshold", () => {
  const classification: ClassifyResult = {
    choice: "sonnet",
    confidence: 0.4,
    probabilities: { haiku: 0.15, sonnet: 0.4, opus: 0.35, fable: 0.1 },
  };
  const decision = decide(classification, state(), currentMessages, DEFAULT_PRICING);
  assert.deepEqual(decision, { kind: "held" });
});

test("downgrades automatically on a steep price drop (opus -> haiku) whose break-even is well under STICKY_ASSUMPTION", () => {
  const classification: ClassifyResult = {
    choice: "haiku",
    confidence: 0.6,
    probabilities: { haiku: 0.6, sonnet: 0.05, opus: 0.3, fable: 0.05 },
  };
  const decision = decide(
    classification,
    state({ currentTier: "opus" }),
    currentMessages,
    DEFAULT_PRICING
  );
  assert.equal(decision.kind, "downgraded");
  if (decision.kind === "downgraded") {
    assert.equal(decision.to, "haiku");
    assert.ok(decision.breakEvenTurns < 1, `expected well under 1, got ${decision.breakEvenTurns}`);
  }
});

test("declines a shallow-drop downgrade (sonnet -> haiku) whose break-even exceeds STICKY_ASSUMPTION", () => {
  const classification: ClassifyResult = {
    choice: "haiku",
    confidence: 0.5,
    probabilities: { haiku: 0.5, sonnet: 0.3, opus: 0.15, fable: 0.05 },
  };
  const decision = decide(classification, state(), currentMessages, DEFAULT_PRICING);
  assert.deepEqual(decision, { kind: "held" });
});

test("never auto-switches on an upgrade outside a reset window; suggests instead, with the real switch-tax as the estimated cost", () => {
  const classification: ClassifyResult = {
    choice: "opus",
    confidence: 0.7,
    probabilities: { haiku: 0.05, sonnet: 0.15, opus: 0.7, fable: 0.1 },
  };
  const decision = decide(classification, state(), currentMessages, DEFAULT_PRICING);
  assert.equal(decision.kind, "upgrade-suggested");
  if (decision.kind === "upgrade-suggested") {
    assert.equal(decision.to, "opus");
    assert.ok(Math.abs(decision.estimatedCostUsd - 0.1315) < 0.0005);
  }
});

test("on reset, adopts the argmax choice immediately with no margin or break-even check, downgrade direction", () => {
  const classification: ClassifyResult = {
    choice: "haiku",
    confidence: 0.34,
    probabilities: { haiku: 0.34, sonnet: 0.33, opus: 0.17, fable: 0.16 },
  };
  const resetState = state({ lastMessages: [], lastMessageCount: 0 });
  const decision = decide(classification, resetState, currentMessages, DEFAULT_PRICING);
  assert.deepEqual(decision, { kind: "downgraded-on-reset", to: "haiku" });
});

test("on reset, adopts the argmax choice immediately, upgrade direction", () => {
  const classification: ClassifyResult = {
    choice: "opus",
    confidence: 0.4,
    probabilities: { haiku: 0.1, sonnet: 0.3, opus: 0.4, fable: 0.2 },
  };
  const resetState = state({ lastMessages: [], lastMessageCount: 0 });
  const decision = decide(classification, resetState, currentMessages, DEFAULT_PRICING);
  assert.deepEqual(decision, { kind: "upgraded-on-reset", to: "opus" });
});

test("on reset, holds when the argmax choice equals the current tier", () => {
  const classification: ClassifyResult = {
    choice: "sonnet",
    confidence: 0.4,
    probabilities: { haiku: 0.2, sonnet: 0.4, opus: 0.3, fable: 0.1 },
  };
  const resetState = state({ lastMessages: [], lastMessageCount: 0 });
  const decision = decide(classification, resetState, currentMessages, DEFAULT_PRICING);
  assert.deepEqual(decision, { kind: "held" });
});

test("when both a downgrade and an upgrade candidate clear the threshold, the larger margin wins (downgrade), and it clears break-even too", () => {
  const classification: ClassifyResult = {
    choice: "haiku",
    confidence: 0.45,
    probabilities: { haiku: 0.45, sonnet: 0.05, opus: 0.15, fable: 0.35 },
  };
  const decision = decide(
    classification,
    state({ currentTier: "opus" }),
    currentMessages,
    DEFAULT_PRICING
  );
  assert.equal(decision.kind, "downgraded");
  if (decision.kind === "downgraded") assert.equal(decision.to, "haiku");
});

test("when both clear the threshold, the larger margin wins (upgrade)", () => {
  const classification: ClassifyResult = {
    choice: "opus",
    confidence: 0.58,
    probabilities: { haiku: 0.22, sonnet: 0.1, opus: 0.58, fable: 0.1 },
  };
  const decision = decide(classification, state(), currentMessages, DEFAULT_PRICING);
  assert.equal(decision.kind, "upgrade-suggested");
  if (decision.kind === "upgrade-suggested") assert.equal(decision.to, "opus");
});
