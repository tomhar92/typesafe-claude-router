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
  currentTier: Tier,
  allowed: { min: Tier; max: Tier } = { min: "haiku", max: "fable" }
): MarginResult {
  const currentIndex = TIER_ORDER.indexOf(currentTier);
  const minIndex = TIER_ORDER.indexOf(allowed.min);
  const maxIndex = TIER_ORDER.indexOf(allowed.max);
  const cheaper = TIER_ORDER.slice(minIndex, Math.min(currentIndex, maxIndex + 1)) as Tier[];
  const pricier = TIER_ORDER.slice(Math.max(currentIndex + 1, minIndex), maxIndex + 1) as Tier[];

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
