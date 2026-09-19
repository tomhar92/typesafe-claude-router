import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMargins } from "../src/margins.js";

test("finds the strongest cheaper and pricier candidates relative to current tier", () => {
  const result = computeMargins(
    { haiku: 0.5, sonnet: 0.35, opus: 0.1, fable: 0.05 },
    "sonnet"
  );
  assert.equal(result.downgradeCandidate, "haiku");
  assert.ok(Math.abs(result.downgradeMargin - (0.5 - 0.35)) < 1e-9);
  assert.equal(result.upgradeCandidate, "opus");
  assert.ok(Math.abs(result.upgradeMargin - (0.1 - 0.35)) < 1e-9);
});

test("has no downgrade candidate when current tier is already the cheapest", () => {
  const result = computeMargins(
    { haiku: 0.6, sonnet: 0.2, opus: 0.15, fable: 0.05 },
    "haiku"
  );
  assert.equal(result.downgradeCandidate, null);
  assert.equal(result.downgradeMargin, -Infinity);
  assert.equal(result.upgradeCandidate, "sonnet");
});

test("has no upgrade candidate when current tier is already the priciest", () => {
  const result = computeMargins(
    { haiku: 0.1, sonnet: 0.15, opus: 0.25, fable: 0.5 },
    "fable"
  );
  assert.equal(result.upgradeCandidate, null);
  assert.equal(result.upgradeMargin, -Infinity);
  assert.equal(result.downgradeCandidate, "opus");
});
