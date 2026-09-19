import { TIER_ORDER, type Tier } from "./types.js";

export interface MarginResult {
  downgradeCandidate: Tier | null;
  downgradeMargin: number;
  upgradeCandidate: Tier | null;
  upgradeMargin: number;
}

function strongest(tiers: Tier[], probabilities: Record<Tier, number>): Tier | null {
  if (tiers.length === 0) return null;
  return tiers.reduce((best, candidate) =>
    probabilities[candidate] > probabilities[best] ? candidate : best
  );
}

export function computeMargins(
  probabilities: Record<Tier, number>,
  currentTier: Tier
): MarginResult {
  const currentIndex = TIER_ORDER.indexOf(currentTier);
  const cheaper = TIER_ORDER.slice(0, currentIndex) as Tier[];
  const pricier = TIER_ORDER.slice(currentIndex + 1) as Tier[];

  const downgradeCandidate = strongest(cheaper, probabilities);
  const upgradeCandidate = strongest(pricier, probabilities);

  return {
    downgradeCandidate,
    downgradeMargin:
      downgradeCandidate === null
        ? -Infinity
        : probabilities[downgradeCandidate] - probabilities[currentTier],
    upgradeCandidate,
    upgradeMargin:
      upgradeCandidate === null
        ? -Infinity
        : probabilities[upgradeCandidate] - probabilities[currentTier],
  };
}
