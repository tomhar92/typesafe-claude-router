import { computeCostUsd } from "./pricing.js";
import type { PricingConfig, Tier } from "./types.js";

export function switchTax(
  lastPrefixTokens: number,
  lastNewTokens: number,
  lastOutputTokens: number,
  currentTier: Tier,
  candidateTier: Tier,
  pricing: PricingConfig
): number {
  // Switching pays the candidate tier's cache-*write* rate on the prefix
  // (the cache is being rebuilt from scratch on the new model).
  const switchTurnCost = computeCostUsd(
    pricing,
    candidateTier,
    lastNewTokens,
    lastOutputTokens,
    lastPrefixTokens,
    0
  );
  // Staying keeps hitting the cache: current tier's *read* rate.
  const stayTurnCost = computeCostUsd(
    pricing,
    currentTier,
    lastNewTokens,
    lastOutputTokens,
    0,
    lastPrefixTokens
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
  const stayTurnCost = computeCostUsd(
    pricing,
    currentTier,
    lastNewTokens,
    lastOutputTokens,
    0,
    lastPrefixTokens
  );
  const candidateSteadyCost = computeCostUsd(
    pricing,
    candidateTier,
    lastNewTokens,
    lastOutputTokens,
    0,
    lastPrefixTokens
  );
  const perTurnSavings = stayTurnCost - candidateSteadyCost;
  if (perTurnSavings <= 0) return Infinity;
  return tax / perTurnSavings;
}
