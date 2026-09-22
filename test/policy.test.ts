import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decide, envNumber } from "../src/policy.js";
import { DEFAULT_PRICING } from "../src/pricing.js";
import type { ConversationState, ClassifyResult } from "../src/types.js";

const thresholdsFixture = fileURLToPath(
  new URL("./fixtures/policy-thresholds.ts", import.meta.url)
);

function readThresholds(env: Record<string, string> = {}): { MARGIN_THRESHOLD: number; STICKY_ASSUMPTION: number } {
  const output = execFileSync(process.execPath, ["--import", "tsx", thresholdsFixture], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return JSON.parse(output);
}

test("MARGIN_THRESHOLD/STICKY_ASSUMPTION default to 0.1/3 with no env override", () => {
  const thresholds = readThresholds();
  assert.equal(thresholds.MARGIN_THRESHOLD, 0.1);
  assert.equal(thresholds.STICKY_ASSUMPTION, 3);
});

test("MARGIN_THRESHOLD/STICKY_ASSUMPTION pick up ROUTER_MARGIN_THRESHOLD/ROUTER_STICKY_ASSUMPTION", () => {
  const thresholds = readThresholds({
    ROUTER_MARGIN_THRESHOLD: "0.25",
    ROUTER_STICKY_ASSUMPTION: "5",
  });
  assert.equal(thresholds.MARGIN_THRESHOLD, 0.25);
  assert.equal(thresholds.STICKY_ASSUMPTION, 5);
});

test("envNumber: uses the fallback when the env var is unset", () => {
  assert.equal(envNumber("ROUTER_TEST_DOES_NOT_EXIST", 0.1), 0.1);
});

test("envNumber: parses a valid numeric value", () => {
  process.env.ROUTER_TEST_NUMBER = "0.25";
  try {
    assert.equal(envNumber("ROUTER_TEST_NUMBER", 0.1), 0.25);
  } finally {
    delete process.env.ROUTER_TEST_NUMBER;
  }
});

test("envNumber: falls back on an empty string, not on Number('') === 0", () => {
  process.env.ROUTER_TEST_NUMBER = "";
  try {
    assert.equal(envNumber("ROUTER_TEST_NUMBER", 3), 3);
  } finally {
    delete process.env.ROUTER_TEST_NUMBER;
  }
});

test("envNumber: falls back on a whitespace-only value, not on Number(' ') === 0", () => {
  process.env.ROUTER_TEST_NUMBER = "   ";
  try {
    assert.equal(envNumber("ROUTER_TEST_NUMBER", 3), 3);
  } finally {
    delete process.env.ROUTER_TEST_NUMBER;
  }
});

test("envNumber: falls back on a non-numeric value instead of silently becoming NaN", () => {
  process.env.ROUTER_TEST_NUMBER = "not-a-number";
  try {
    assert.equal(envNumber("ROUTER_TEST_NUMBER", 3), 3);
  } finally {
    delete process.env.ROUTER_TEST_NUMBER;
  }
});

test("envNumber: falls back on Infinity/-Infinity instead of a threshold no margin could ever clear", () => {
  process.env.ROUTER_TEST_NUMBER = "Infinity";
  try {
    assert.equal(envNumber("ROUTER_TEST_NUMBER", 0.1), 0.1);
  } finally {
    delete process.env.ROUTER_TEST_NUMBER;
  }
});

function state(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    connectionId: "conn-1",
    currentTier: "sonnet",
    turnsOnCurrentTier: 5,
    lastPrefixTokens: 20_000,
    lastNewTokens: 1_000,
    lastOutputTokens: 500,
    lastMessages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }],
    lastRequestedTier: "sonnet",
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
  const resetState = state({ lastMessages: [] });
  const decision = decide(classification, resetState, currentMessages, DEFAULT_PRICING);
  assert.deepEqual(decision, { kind: "downgraded-on-reset", to: "haiku" });
});

test("on reset, adopts the argmax choice immediately, upgrade direction", () => {
  const classification: ClassifyResult = {
    choice: "opus",
    confidence: 0.4,
    probabilities: { haiku: 0.1, sonnet: 0.3, opus: 0.4, fable: 0.2 },
  };
  const resetState = state({ lastMessages: [] });
  const decision = decide(classification, resetState, currentMessages, DEFAULT_PRICING);
  assert.deepEqual(decision, { kind: "upgraded-on-reset", to: "opus" });
});

test("on reset, holds when the argmax choice equals the current tier", () => {
  const classification: ClassifyResult = {
    choice: "sonnet",
    confidence: 0.4,
    probabilities: { haiku: 0.2, sonnet: 0.4, opus: 0.3, fable: 0.1 },
  };
  const resetState = state({ lastMessages: [] });
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
