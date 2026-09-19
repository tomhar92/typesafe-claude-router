import type { Tier } from "./types.js";

export function buildUpgradeNoteBlock(tier: Tier, estimatedCostUsd: number) {
  return {
    type: "text" as const,
    text:
      `<system-reminder>Router note: this turn looks like it may benefit from ` +
      `${tier}-tier reasoning. Estimated one-time cost to switch now (cache rebuild): ` +
      `$${estimatedCostUsd.toFixed(4)}. Mention this to the user briefly if relevant; ` +
      `switching is their call (\`/model ${tier}\`).</system-reminder>`,
  };
}
