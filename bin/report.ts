#!/usr/bin/env node
import { readLedger, type LedgerLine } from "../src/ledger.js";
import { isMainModule } from "../src/isMainModule.js";

export interface Summary {
  turns: number;
  held: number;
  downgraded: number;
  upgradedOnReset: number;
  suggested: number;
  classifierUnavailable: number;
  totalActualUsd: number;
  totalCounterfactualUsd: number;
  deltaUsd: number;
}

export function summarize(lines: LedgerLine[]): Summary {
  const totalActualUsd = lines.reduce((sum, l) => sum + l.actualCostUsd, 0);
  const totalCounterfactualUsd = lines.reduce(
    (sum, l) => sum + l.counterfactualNoRoutingCostUsd,
    0
  );
  return {
    turns: lines.length,
    held: lines.filter((l) => l.decision === "held").length,
    downgraded: lines.filter(
      (l) => l.decision === "downgraded" || l.decision === "downgraded-on-reset"
    ).length,
    upgradedOnReset: lines.filter((l) => l.decision === "upgraded-on-reset").length,
    suggested: lines.filter((l) => l.decision === "upgrade-suggested").length,
    classifierUnavailable: lines.filter((l) => l.decision === "classifier-unavailable").length,
    totalActualUsd,
    totalCounterfactualUsd,
    deltaUsd: totalActualUsd - totalCounterfactualUsd,
  };
}

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: typesafe-claude-router-report <path-to-ledger.jsonl>");
    process.exit(1);
  }
  const lines = readLedger(path);
  if (lines.length === 0) {
    console.log(`No ledger entries found at ${path}`);
    return;
  }
  const s = summarize(lines);
  console.log(`Turns: ${s.turns}`);
  console.log(
    `  held: ${s.held}, downgraded: ${s.downgraded}, upgraded-on-reset: ${s.upgradedOnReset}, upgrade-suggested: ${s.suggested}`
  );
  if (s.classifierUnavailable > 0) {
    console.log(
      `  classifier-unavailable: ${s.classifierUnavailable} (TypeSafe errored/timed out - router held by default, not by policy, on these turns)`
    );
  }
  console.log(`Actual cost:         $${s.totalActualUsd.toFixed(4)}`);
  console.log(`No-routing baseline: $${s.totalCounterfactualUsd.toFixed(4)}`);
  console.log(
    `Delta:               $${s.deltaUsd.toFixed(4)} (${s.deltaUsd < 0 ? "saved" : "cost more"})`
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
