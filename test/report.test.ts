import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../bin/report.js";
import type { LedgerLine } from "../src/ledger.js";

function line(overrides: Partial<LedgerLine>): LedgerLine {
  return {
    ts: new Date().toISOString(),
    conversationKey: "conn-1",
    probabilities: { haiku: 0.25, sonnet: 0.25, opus: 0.25, fable: 0.25 },
    confidence: 0.5,
    downgradeMargin: 0,
    upgradeMargin: 0,
    decision: "held",
    resetDetected: false,
    suggestedUpgradeTo: null,
    suggestedUpgradeCostUsd: null,
    actualModel: "claude-sonnet-5",
    actualTier: "sonnet",
    turnsOnCurrentTier: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    actualCostUsd: 0,
    counterfactualNoRoutingCostUsd: 0,
    ...overrides,
  };
}

test("summarize counts each decision kind and totals actual vs counterfactual cost", () => {
  const lines: LedgerLine[] = [
    line({ decision: "held", actualCostUsd: 0.01, counterfactualNoRoutingCostUsd: 0.01 }),
    line({ decision: "downgraded", actualCostUsd: 0.005, counterfactualNoRoutingCostUsd: 0.01 }),
    line({ decision: "downgraded-on-reset", actualCostUsd: 0.001, counterfactualNoRoutingCostUsd: 0.002 }),
    line({ decision: "upgraded-on-reset", actualCostUsd: 0.02, counterfactualNoRoutingCostUsd: 0.01 }),
    line({ decision: "upgrade-suggested", actualCostUsd: 0.01, counterfactualNoRoutingCostUsd: 0.01 }),
  ];
  const summary = summarize(lines);
  assert.equal(summary.turns, 5);
  assert.equal(summary.held, 1);
  assert.equal(summary.downgraded, 2);
  assert.equal(summary.upgradedOnReset, 1);
  assert.equal(summary.suggested, 1);
  assert.ok(Math.abs(summary.totalActualUsd - 0.046) < 1e-9);
  assert.ok(Math.abs(summary.totalCounterfactualUsd - 0.042) < 1e-9);
  assert.ok(Math.abs(summary.deltaUsd - (0.046 - 0.042)) < 1e-9);
});

test("summarize handles an empty ledger", () => {
  const summary = summarize([]);
  assert.equal(summary.turns, 0);
  assert.equal(summary.totalActualUsd, 0);
  assert.equal(summary.totalCounterfactualUsd, 0);
});

test("summarize counts classifier-unavailable turns separately from a policy-driven hold", () => {
  const lines: LedgerLine[] = [
    line({ decision: "held" }),
    line({ decision: "classifier-unavailable", probabilities: {} as LedgerLine["probabilities"], confidence: null }),
    line({ decision: "classifier-unavailable", probabilities: {} as LedgerLine["probabilities"], confidence: null }),
  ];
  const summary = summarize(lines);
  assert.equal(summary.turns, 3);
  assert.equal(summary.held, 1);
  assert.equal(summary.classifierUnavailable, 2);
});
