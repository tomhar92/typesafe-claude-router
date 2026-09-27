import type { PricingConfig, Tier } from "./types.js";

// Source: web research 2026-09-19 (Claude API list pricing: Haiku 4.5 $1/$5,
// Sonnet 5 $2/$10, Opus 5 $5/$25, Fable 5.1 $10/$50 per Mtok in/out; cache
// read = 0.1x input, cache write (5m TTL) = 1.25x input, per Anthropic's
// prompt-caching pricing). Verify against current pricing before trusting
// real spend numbers — see README.
function ratesFromInput(inputPerMTok: number, outputPerMTok: number) {
  return {
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok: inputPerMTok * 0.1,
    cacheWritePerMTok: inputPerMTok * 1.25,
  };
}

export const DEFAULT_PRICING: PricingConfig = {
  rates: {
    haiku: ratesFromInput(1, 5),
    sonnet: ratesFromInput(2, 10),
    opus: ratesFromInput(5, 25),
    fable: ratesFromInput(10, 50),
  },
  modelAlias: {
    haiku: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "claude-haiku-4-5",
    sonnet: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "claude-sonnet-5",
    opus: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? "claude-opus-5",
    fable: process.env.ANTHROPIC_DEFAULT_FABLE_MODEL ?? "claude-fable-5-1",
  },
};

// A model ID is a tier name embedded in a longer, versioned string:
// `claude-opus-5-20260101`, `claude-3-5-haiku-20241022`,
// `us.anthropic.claude-sonnet-5-v1:0`. Exact equality matched only the
// bare aliases, so every real request from Claude Code resolved to null
// and the caller's `?? "sonnet"` fallback quietly took over - which in
// live mode rewrote Opus sessions to Sonnet and logged them as `held`.
const TIER_PATTERNS: ReadonlyArray<readonly [Tier, RegExp]> = [
  ["fable", /(^|[^a-z0-9])fable([^a-z0-9]|$)/],
  ["opus", /(^|[^a-z0-9])opus([^a-z0-9]|$)/],
  ["sonnet", /(^|[^a-z0-9])sonnet([^a-z0-9]|$)/],
  ["haiku", /(^|[^a-z0-9])haiku([^a-z0-9]|$)/],
];

export function tierForModel(pricing: PricingConfig, model: unknown): Tier | null {
  if (typeof model !== "string" || model.length === 0) return null;
  // An exact alias wins over the patterns: it is the operator's own
  // mapping, and ANTHROPIC_DEFAULT_*_MODEL may deliberately point a tier
  // at a model whose name says otherwise.
  for (const [tier, alias] of Object.entries(pricing.modelAlias) as [Tier, string][]) {
    if (alias === model) return tier;
  }
  const normalized = model.toLowerCase();
  for (const [tier, pattern] of TIER_PATTERNS) {
    if (pattern.test(normalized)) return tier;
  }
  return null;
}

/**
 * The one place that turns token counts into a dollar cost. `breakEven.ts`
 * used to duplicate this arithmetic in its own `turnCost` helper (with a
 * `cacheField` parameter picking read vs. write) - same formula, two
 * places to get subtly out of sync.
 */
export function computeCostUsd(
  pricing: PricingConfig,
  tier: Tier,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number
): number {
  const rates = pricing.rates[tier];
  return (
    (inputTokens * rates.inputPerMTok +
      outputTokens * rates.outputPerMTok +
      cacheCreationTokens * rates.cacheWritePerMTok +
      cacheReadTokens * rates.cacheReadPerMTok) /
    1_000_000
  );
}
