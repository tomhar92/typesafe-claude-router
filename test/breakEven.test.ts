import { test } from "node:test";
import assert from "node:assert/strict";
import { breakEvenTurns, switchTax } from "../src/breakEven.js";
import { DEFAULT_PRICING } from "../src/pricing.js";

test("matches the design spec's worked example: ~3.2 turns to break even, sonnet -> haiku, 20k prefix / 1k new / 500 output", () => {
  const turns = breakEvenTurns(20_000, 1_000, 500, "sonnet", "haiku", DEFAULT_PRICING);
  assert.ok(turns > 3 && turns < 3.3, `expected ~3.18, got ${turns}`);
});

test("a steep price drop (opus -> haiku) pays back in well under one turn", () => {
  const turns = breakEvenTurns(20_000, 1_000, 500, "opus", "haiku", DEFAULT_PRICING);
  assert.ok(turns < 1, `expected well under 1, got ${turns}`);
});

test("returns Infinity when the candidate tier is not actually cheaper to read", () => {
  const turns = breakEvenTurns(20_000, 1_000, 500, "haiku", "sonnet", DEFAULT_PRICING);
  assert.equal(turns, Infinity);
});

test("switchTax for an upgrade is positive (spending more never pays for itself in cache terms)", () => {
  const tax = switchTax(20_000, 1_000, 500, "sonnet", "opus", DEFAULT_PRICING);
  assert.ok(Math.abs(tax - 0.1315) < 0.0005, `expected ~0.1315, got ${tax}`);
});
