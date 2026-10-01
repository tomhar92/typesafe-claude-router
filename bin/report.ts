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
  unknownModel: number;
  totalActualUsd: number;
  totalCounterfactualUsd: number;
  deltaUsd: number;
}

export function summarize(lines: LedgerLine[]): Summary {
  const totalActualUsd = lines.reduce((sum, l) => sum + (l.actualCostUsd ?? 0), 0);
  const totalCounterfactualUsd = lines.reduce(
    (sum, l) => sum + (l.counterfactualNoRoutingCostUsd ?? 0),
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
    unknownModel: lines.filter((l) => l.decision === "unknown-model").length,
    totalActualUsd,
    totalCounterfactualUsd,
    deltaUsd: totalActualUsd - totalCounterfactualUsd,
  };
}

const USAGE = "Usage: typesafe-claude-router-report [path-to-ledger.jsonl]";

/** `--help` is the only way to get the usage line now: with a default
 * path, the bare invocation is valid. */
export function resolveLedgerPath(argv: string[], env: NodeJS.ProcessEnv): string | null {
  if (argv.includes("--help") || argv.includes("-h")) return null;
  return argv[0] ?? env.ROUTER_LEDGER_PATH ?? "./router-ledger.jsonl";
}

export function reportMain(argv: string[]): void {
  const path = resolveLedgerPath(argv, process.env);
  if (!path) {
    console.log(USAGE);
    return;
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
  if (s.unknownModel > 0) {
    console.log(
      `  unknown-model: ${s.unknownModel} (no tier resolved - forwarded untouched, not priced; add the model to modelAlias in src/pricing.ts)`
    );
  }
  console.log(`Actual cost:         $${s.totalActualUsd.toFixed(4)}`);
  console.log(`No-routing baseline: $${s.totalCounterfactualUsd.toFixed(4)}`);
  console.log(
    `Delta:               $${s.deltaUsd.toFixed(4)} (${s.deltaUsd < 0 ? "saved" : "cost more"})`
  );
}

if (isMainModule(import.meta.url)) {
  reportMain(process.argv.slice(2));
}
