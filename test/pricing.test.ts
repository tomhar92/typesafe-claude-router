import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PRICING, tierForModel } from "../src/pricing.js";
import type { Tier } from "../src/types.js";

test("tierForModel resolves a configured model alias back to its tier", () => {
  const model = DEFAULT_PRICING.modelAlias.haiku;
  assert.equal(tierForModel(DEFAULT_PRICING, model), "haiku");
});

test("tierForModel returns null for an unknown model string", () => {
  assert.equal(tierForModel(DEFAULT_PRICING, "not-a-real-model"), null);
});

test("resolves a tier from dated and vendor-prefixed model ids", () => {
  const cases: [string, Tier | null][] = [
    ["claude-sonnet-5", "sonnet"],
    ["claude-sonnet-5-20250929", "sonnet"],
    ["claude-opus-5-20260101", "opus"],
    ["claude-3-5-haiku-20241022", "haiku"],
    ["claude-fable-5-1", "fable"],
    ["us.anthropic.claude-opus-5-v1:0", "opus"],
    ["gpt-4o", null],
    ["", null],
  ];
  for (const [model, expected] of cases) {
    assert.equal(tierForModel(DEFAULT_PRICING, model), expected, model);
  }
});

test("an explicit alias wins over the name-based patterns", () => {
  const pricing = {
    ...DEFAULT_PRICING,
    modelAlias: { ...DEFAULT_PRICING.modelAlias, haiku: "claude-sonnet-5-cheap-preview" },
  };
  assert.equal(tierForModel(pricing, "claude-sonnet-5-cheap-preview"), "haiku");
});

test("cache read/write rates are derived consistently from input rate", () => {
  for (const tier of ["haiku", "sonnet", "opus", "fable"] as const) {
    const rates = DEFAULT_PRICING.rates[tier];
    assert.ok(Math.abs(rates.cacheReadPerMTok - rates.inputPerMTok * 0.1) < 1e-9);
    assert.ok(Math.abs(rates.cacheWritePerMTok - rates.inputPerMTok * 1.25) < 1e-9);
  }
});
