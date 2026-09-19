import type { PricingConfig, Tier } from "./types.js";

type CacheField = "cacheReadPerMTok" | "cacheWritePerMTok";

function turnCost(
  tier: Tier,
  cacheTokens: number,
  cacheField: CacheField,
  newTokens: number,
  outputTokens: number,
  pricing: PricingConfig
): number {
  const rates = pricing.rates[tier];
  return (
    (cacheTokens * rates[cacheField] +
      newTokens * rates.inputPerMTok +
      outputTokens * rates.outputPerMTok) /
    1_000_000
  );
}

export function switchTax(
  lastPrefixTokens: number,
  lastNewTokens: number,
  lastOutputTokens: number,
  currentTier: Tier,
  candidateTier: Tier,
  pricing: PricingConfig
): number {
  const switchTurnCost = turnCost(
    candidateTier,
    lastPrefixTokens,
    "cacheWritePerMTok",
    lastNewTokens,
    lastOutputTokens,
    pricing
  );
  const stayTurnCost = turnCost(
    currentTier,
    lastPrefixTokens,
    "cacheReadPerMTok",
    lastNewTokens,
    lastOutputTokens,
    pricing
  );
  return switchTurnCost - stayTurnCost;
}

export function breakEvenTurns(
  lastPrefixTokens: number,
  lastNewTokens: number,
  lastOutputTokens: number,
  currentTier: Tier,
  candidateTier: Tier,
  pricing: PricingConfig
): number {
  const tax = switchTax(
    lastPrefixTokens,
    lastNewTokens,
    lastOutputTokens,
    currentTier,
    candidateTier,
    pricing
  );
  const stayTurnCost = turnCost(
    currentTier,
    lastPrefixTokens,
    "cacheReadPerMTok",
    lastNewTokens,
    lastOutputTokens,
    pricing
  );
  const candidateSteadyCost = turnCost(
    candidateTier,
    lastPrefixTokens,
    "cacheReadPerMTok",
    lastNewTokens,
    lastOutputTokens,
    pricing
  );
  const perTurnSavings = stayTurnCost - candidateSteadyCost;
  if (perTurnSavings <= 0) return Infinity;
  return tax / perTurnSavings;
}
