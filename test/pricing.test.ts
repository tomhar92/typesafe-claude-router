import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PRICING, tierForModel } from "../src/pricing.js";

test("tierForModel resolves a configured model alias back to its tier", () => {
  const model = DEFAULT_PRICING.modelAlias.haiku;
  assert.equal(tierForModel(DEFAULT_PRICING, model), "haiku");
});

test("tierForModel returns null for an unknown model string", () => {
  assert.equal(tierForModel(DEFAULT_PRICING, "not-a-real-model"), null);
});

test("cache read/write rates are derived consistently from input rate", () => {
  for (const tier of ["haiku", "sonnet", "opus", "fable"] as const) {
    const rates = DEFAULT_PRICING.rates[tier];
    assert.ok(Math.abs(rates.cacheReadPerMTok - rates.inputPerMTok * 0.1) < 1e-9);
    assert.ok(Math.abs(rates.cacheWritePerMTok - rates.inputPerMTok * 1.25) < 1e-9);
  }
});
