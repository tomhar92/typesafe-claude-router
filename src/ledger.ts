import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Tier } from "./types.js";

export { computeCostUsd } from "./pricing.js";

export interface LedgerLine {
  v: 2;
  ts: string;
  conversationKey: string;
  probabilities: Record<Tier, number>;
  /** The classifier's confidence in its argmax choice, or null when the
   * classifier was unavailable this turn (see `decision`). */
  confidence: number | null;
  downgradeMargin: number;
  upgradeMargin: number;
  /** One of the `Decision["kind"]` values from policy.ts, or
   * `"classifier-unavailable"` when TypeSafe errored/timed out and the
   * router held by default rather than by policy, `"skipped-tool-result"`
   * when the request only continued an agentic loop and was not
   * classified, `"side-request"` for Claude Code's tool-less side calls
   * (logged for cost, never routed), or `"unknown-model"`
   * when no tier could be resolved for the requested model - kept
   * distinct so a broken API key or an unrecognized model doesn't
   * silently masquerade as normal routing. */
  decision: string;
  resetDetected: boolean;
  suggestedUpgradeTo: Tier | null;
  suggestedUpgradeCostUsd: number | null;
  actualModel: string;
  /** Null when the turn used a model no tier could be resolved for; the
   * turn is still recorded so the report can count it, but it carries no
   * cost because we have no rate card for that model. */
  actualTier: Tier | null;
  /** How many consecutive turns (including this one) the conversation has
   * now spent on `actualTier`. */
  turnsOnCurrentTier: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  actualCostUsd: number | null;
  counterfactualNoRoutingCostUsd: number | null;
}

export function appendLedgerLine(path: string, line: LedgerLine): void {
  // A single small JSONL append is sub-millisecond on any real disk and
  // negligible next to the network round-trip this proxy is already
  // waiting on for every turn - not worth trading the simple, easy-to-
  // reason-about ordering a synchronous write gives (this line is either
  // durable before the response finishes, or the process crashed and
  // nothing after it ran either) for the async version's own hazard: a
  // fire-and-forget write racing an unrelated "did the response finish"
  // signal, with no guarantee about which comes first.
  appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
}

export function readLedger(path: string): LedgerLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      // Lines written before the unknown-model change carry no `v` and
      // always have a tier and both costs. Defaulting here keeps an
      // existing router-ledger.jsonl reportable instead of dropping it.
      const parsed = JSON.parse(l) as Partial<LedgerLine>;
      return { v: 2, ...parsed } as LedgerLine;
    });
}
