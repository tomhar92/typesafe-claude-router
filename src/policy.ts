import { TIER_ORDER, type ClassifyResult, type ConversationState, type Decision, type PricingConfig } from "./types.js";
import { detectReset } from "./reset.js";
import { computeMargins } from "./margins.js";
import { breakEvenTurns, switchTax } from "./breakEven.js";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const MARGIN_THRESHOLD = envNumber("ROUTER_MARGIN_THRESHOLD", 0.1);
export const STICKY_ASSUMPTION = envNumber("ROUTER_STICKY_ASSUMPTION", 3);

export function decide(
  classification: ClassifyResult,
  state: ConversationState,
  currentMessages: unknown[],
  pricing: PricingConfig
): Decision {
  const isReset = detectReset(state.lastMessages, currentMessages);

  if (isReset) {
    const to = classification.choice;
    if (to === state.currentTier) return { kind: "held" };
    const isDowngrade = TIER_ORDER.indexOf(to) < TIER_ORDER.indexOf(state.currentTier);
    return isDowngrade ? { kind: "downgraded-on-reset", to } : { kind: "upgraded-on-reset", to };
  }

  const { downgradeCandidate, downgradeMargin, upgradeCandidate, upgradeMargin } =
    computeMargins(classification.probabilities, state.currentTier);

  const downgradeEligible = downgradeCandidate !== null && downgradeMargin > MARGIN_THRESHOLD;
  const upgradeEligible = upgradeCandidate !== null && upgradeMargin > MARGIN_THRESHOLD;

  if (!downgradeEligible && !upgradeEligible) {
    return { kind: "held" };
  }

  const preferDowngrade =
    downgradeEligible && (!upgradeEligible || downgradeMargin >= upgradeMargin);

  if (preferDowngrade) {
    const turns = breakEvenTurns(
      state.lastPrefixTokens,
      state.lastNewTokens,
      state.lastOutputTokens,
      state.currentTier,
      downgradeCandidate!,
      pricing
    );
    if (turns <= STICKY_ASSUMPTION) {
      return { kind: "downgraded", to: downgradeCandidate!, breakEvenTurns: turns };
    }
    return { kind: "held" };
  }

  const estimatedCostUsd = switchTax(
    state.lastPrefixTokens,
    state.lastNewTokens,
    state.lastOutputTokens,
    state.currentTier,
    upgradeCandidate!,
    pricing
  );
  return { kind: "upgrade-suggested", to: upgradeCandidate!, estimatedCostUsd };
}
