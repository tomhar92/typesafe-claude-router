import { TIER_ORDER, type ClassifyResult, type ConversationState, type Decision, type PricingConfig, type Tier } from "./types.js";
import { detectReset } from "./reset.js";
import { computeMargins } from "./margins.js";
import { breakEvenTurns, switchTax } from "./breakEven.js";

export function envNumber(name: string, fallback: number): number {
  // Trimmed and checked for emptiness *before* Number(): Number(" ") is 0,
  // so an untrimmed whitespace-only value (a stray trailing space from a
  // copy-pasted .env line, an empty template substitution, ...) would
  // otherwise silently become a real, very-different threshold (0) rather
  // than falling back.
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function envTier(name: string, fallback: Tier): Tier {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return (TIER_ORDER as readonly string[]).includes(raw) ? (raw as Tier) : fallback;
}

export interface PolicyLimits {
  marginThreshold: number;
  stickyAssumption: number;
  minTier: Tier;
  maxTier: Tier;
  resetConfidenceFloor: number;
}

export const MARGIN_THRESHOLD = envNumber("ROUTER_MARGIN_THRESHOLD", 0.1);
export const STICKY_ASSUMPTION = envNumber("ROUTER_STICKY_ASSUMPTION", 3);

export const DEFAULT_LIMITS: PolicyLimits = {
  marginThreshold: MARGIN_THRESHOLD,
  stickyAssumption: STICKY_ASSUMPTION,
  minTier: envTier("ROUTER_MIN_TIER", "haiku"),
  maxTier: envTier("ROUTER_MAX_TIER", "fable"),
  resetConfidenceFloor: envNumber("ROUTER_RESET_CONFIDENCE_FLOOR", 0.5),
};

function clampTier(tier: Tier, limits: PolicyLimits): Tier {
  const index = TIER_ORDER.indexOf(tier);
  const low = TIER_ORDER.indexOf(limits.minTier);
  const high = TIER_ORDER.indexOf(limits.maxTier);
  if (index < low) return limits.minTier;
  if (index > high) return limits.maxTier;
  return tier;
}

export function decide(
  classification: ClassifyResult,
  state: ConversationState,
  currentMessages: unknown[],
  pricing: PricingConfig,
  limits: PolicyLimits = DEFAULT_LIMITS
): Decision {
  const isReset = detectReset(state.lastMessages, currentMessages);

  if (isReset) {
    // A reset is a free window - the cache is being rebuilt anyway - but
    // "free to switch" is not "switch on any signal". Taking the raw
    // argmax here let a 0.34/0.33 split park a fresh session on the most
    // expensive tier for the rest of its life, since a later downgrade
    // still has to clear the break-even test.
    const to = clampTier(classification.choice, limits);
    if (to === state.currentTier) return { kind: "held" };
    if (classification.confidence < limits.resetConfidenceFloor) return { kind: "held" };
    // The margin for `to` specifically, not the strongest candidate's:
    // after clamping, `to` may not be the tier computeMargins would pick.
    const margin = classification.probabilities[to] - classification.probabilities[state.currentTier];
    if (!(margin > limits.marginThreshold)) return { kind: "held" };
    const isDowngrade = TIER_ORDER.indexOf(to) < TIER_ORDER.indexOf(state.currentTier);
    return isDowngrade ? { kind: "downgraded-on-reset", to } : { kind: "upgraded-on-reset", to };
  }

  const { downgradeCandidate, downgradeMargin, upgradeCandidate, upgradeMargin } =
    computeMargins(classification.probabilities, state.currentTier, { min: limits.minTier, max: limits.maxTier });

  const downgradeEligible = downgradeCandidate !== null && downgradeMargin > limits.marginThreshold;
  const upgradeEligible = upgradeCandidate !== null && upgradeMargin > limits.marginThreshold;

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
    if (turns <= limits.stickyAssumption) {
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
