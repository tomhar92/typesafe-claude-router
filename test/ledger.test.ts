import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedgerLine, readLedger, computeCostUsd, type LedgerLine } from "../src/ledger.js";
import { DEFAULT_PRICING } from "../src/pricing.js";

function line(overrides: Partial<LedgerLine> = {}): LedgerLine {
  return {
    ts: new Date().toISOString(),
    conversationKey: "conn-1",
    probabilities: { haiku: 0.1, sonnet: 0.8, opus: 0.05, fable: 0.05 },
    confidence: 0.8,
    downgradeMargin: -0.05,
    upgradeMargin: -0.75,
    decision: "held",
    resetDetected: false,
    suggestedUpgradeTo: null,
    suggestedUpgradeCostUsd: null,
    actualModel: DEFAULT_PRICING.modelAlias.sonnet,
    actualTier: "sonnet",
    turnsOnCurrentTier: 1,
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 20000,
    actualCostUsd: 0.011,
    counterfactualNoRoutingCostUsd: 0.011,
    ...overrides,
  };
}

test("readLedger returns an empty array when the file does not exist", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "missing.jsonl");
  assert.deepEqual(readLedger(path), []);
});

test("appendLedgerLine writes JSONL that readLedger parses back", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  appendLedgerLine(path, line({ decision: "downgraded" }));
  appendLedgerLine(path, line({ decision: "held" }));
  const lines = readLedger(path);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].decision, "downgraded");
  assert.equal(lines[1].decision, "held");
});

test("computeCostUsd sums input, output, cache-write, and cache-read tokens at their own rates", () => {
  const cost = computeCostUsd(DEFAULT_PRICING, "sonnet", 1000, 500, 0, 20000);
  const expected =
    (1000 * 2 + 500 * 10 + 0 * 2.5 + 20000 * 0.2) / 1_000_000;
  assert.ok(Math.abs(cost - expected) < 1e-9);
});
