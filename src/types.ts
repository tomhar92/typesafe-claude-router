export type Tier = "haiku" | "sonnet" | "opus" | "fable";

export const TIER_ORDER: readonly Tier[] = ["haiku", "sonnet", "opus", "fable"];

export interface PricingRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export interface PricingConfig {
  rates: Record<Tier, PricingRates>;
  modelAlias: Record<Tier, string>;
}

export interface ClassifyResult {
  choice: Tier;
  confidence: number;
  probabilities: Record<Tier, number>;
}

export interface ConversationState {
  currentTier: Tier;
  turnsOnCurrentTier: number;
  lastPrefixTokens: number;
  lastNewTokens: number;
  lastOutputTokens: number;
  lastMessageCount: number;
  lastMessages: unknown[];
  /** The tier Claude Code itself requested on the most recent turn, used to
   * detect a manual `/model` change so the router doesn't fight it. */
  lastRequestedTier: Tier;
}

export type Decision =
  | { kind: "held" }
  | { kind: "downgraded"; to: Tier; breakEvenTurns: number }
  | { kind: "downgraded-on-reset"; to: Tier }
  | { kind: "upgraded-on-reset"; to: Tier }
  | { kind: "upgrade-suggested"; to: Tier; estimatedCostUsd: number };
