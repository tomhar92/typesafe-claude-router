import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { PricingConfig, Tier } from "./types.js";

export interface LedgerLine {
  ts: string;
  conversationKey: string;
  probabilities: Record<Tier, number>;
  downgradeMargin: number;
  upgradeMargin: number;
  decision: string;
  resetDetected: boolean;
  suggestedUpgradeTo: Tier | null;
  suggestedUpgradeCostUsd: number | null;
  actualModel: string;
  actualTier: Tier;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  actualCostUsd: number;
  counterfactualNoRoutingCostUsd: number;
}

export function appendLedgerLine(path: string, line: LedgerLine): void {
  appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
}

export function readLedger(path: string): LedgerLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LedgerLine);
}

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
