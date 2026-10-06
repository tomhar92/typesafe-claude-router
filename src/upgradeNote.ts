import type { Tier } from "./types.js";

// Shown to the user under the model's reply. It is worded as the router
// speaking so it is not mistaken for something the model said.
export function buildUpgradeNoticeText(tier: Tier, estimatedCostUsd: number): string {
  return (
    `\n\n---\n*Router note: this looks like it may suit ${tier}. ` +
    `Switching now means rebuilding the conversation cache, about ` +
    `$${estimatedCostUsd.toFixed(2)} one time. Run \`/model ${tier}\` if you want it.*`
  );
}
