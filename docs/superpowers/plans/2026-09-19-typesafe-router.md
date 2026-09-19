# TypeSafe Router for Claude Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local HTTP proxy that sits between Claude Code and the Anthropic API, uses TypeSafe's Jev `Choice` primitive to judge which of four model tiers a turn needs, and only ever acts on that judgment when the math says it's actually worth the prompt-cache switch tax — with real usage logging so a session's savings/losses can be measured, not guessed.

**Architecture:** Single Node/TypeScript process (`src/server.ts`) using Node's built-in `http` and global `fetch`, no web framework. Pure, independently-tested modules for the decision logic (`reset.ts`, `margins.ts`, `breakEven.ts`, `policy.ts`) are composed by the server, which also owns per-connection conversation state, calls TypeSafe for classification, and appends every turn's real cost data to a JSONL ledger that a small CLI (`bin/report.ts`) summarizes.

**Tech Stack:** TypeScript (Node 20+), `@typesafe-ai/sdk` for classification, `tsx` for running TypeScript directly (dev + tests, no build step required to develop), `typescript`'s `tsc` for the publishable build, Node's built-in `node:test` + `node:assert/strict` for tests (no test framework dependency).

**Spec:** `docs/superpowers/specs/2026-09-19-typesafe-router-design.md`

## Global Constraints

- The proxy must forward all request headers and body fields verbatim except `model` (and, only for `upgrade-suggested`, an appended note in the last user message's content) — dropping or rejecting `cache_control` or `anthropic-beta` headers silently breaks Anthropic's prompt cache for every turn. (Spec: "Request path", step 1.)
- Tier order for all comparisons: `haiku < sonnet < opus < fable`. (Spec: "Policy".)
- Decisions compare TypeSafe's raw `probabilities` against the current tier's probability, not the collapsed `confidence` number. Default margin threshold: `0.1`, one config value for both directions unless overridden separately as `DOWNGRADE_MARGIN_THRESHOLD` / `UPGRADE_MARGIN_THRESHOLD`. (Spec: "Policy", "Upgrade suggestions".)
- Downgrades are fully automatic, gated by switch-tax break-even math (default `STICKY_ASSUMPTION = 3` turns). Upgrades are never auto-applied outside a reset window — always surfaced as a suggestion. (Spec: "Goal", "Policy".)
- On any TypeSafe error or timeout (default budget 2s), hold the current tier — the router must never block or fail a turn. (Spec: "Policy", step 4.)
- Conversation identity is keyed by the TCP connection (`req.socket`), not content hash, to avoid merging state between parallel same-directory sessions. (Spec: "Conversation identity".)
- The cost ledger must use real `usage` fields from actual API responses (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), and compute a counterfactual cost against whichever tier the conversation actually started on — never hardcode Sonnet as the baseline. (Spec: "Cost ledger and report".)
- Pricing/model-alias values live in one editable config module and must note their source/date, since they will drift. (Spec: "Policy", "Open risks".)

---

## File Structure

```
typesafe-claude-router/
  src/
    types.ts            # shared types: Tier, PricingConfig, ClassifyResult, ConversationState, Decision
    pricing.ts           # DEFAULT_PRICING table + tierForModel()
    reset.ts              # detectReset() — messages-array-shape heuristic
    margins.ts             # computeMargins() — probability comparison vs current tier
    breakEven.ts            # switchTax()/breakEvenTurns() — whole-turn switch-tax math
    policy.ts                # decide() — orchestrates reset/margins/breakEven into a Decision
    classify.ts               # classifyTurn() — TypeSafe Jev Choice call, injectable + timeout-guarded
    conversationKey.ts         # per-socket ConversationState store
    upgradeNote.ts               # buildUpgradeNoteBlock() — the injected suggestion content block
    ledger.ts                     # appendLedgerLine(), readLedger(), computeCostUsd()
    server.ts                      # HTTP proxy: createProxyServer(), handleMessages()
  bin/
    report.ts             # CLI: reads ledger, prints cost/savings summary
  test/
    smoke.test.ts
    pricing.test.ts
    reset.test.ts
    margins.test.ts
    breakEven.test.ts
    policy.test.ts
    classify.test.ts
    ledger.test.ts
    server.test.ts
    report.test.ts
  README.md
  LICENSE
  package.json
  tsconfig.json
  .gitignore
```

Note: the spec's file layout didn't list `types.ts`; it's added here as a single shared-types module so `Tier`, `ConversationState`, `Decision`, etc. have one definition every other module imports, rather than each module redeclaring compatible-but-separate shapes. The spec's `conversationKey.ts` now also holds the state-store functions (`getOrInitState`/`updateState`), matching the "Conversation identity" section's connection-keyed design.

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `LICENSE`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Produces: `npm test`, `npm run build`, `npm start`, `npm run report` scripts that later tasks rely on; `tsx`-based test execution so `.ts` test files run without a separate compile step.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "typesafe-claude-router",
  "version": "0.1.0",
  "description": "Cache-aware, TypeSafe-driven model tier router for Claude Code",
  "type": "module",
  "license": "MIT",
  "bin": {
    "typesafe-claude-router-report": "./dist/bin/report.js"
  },
  "scripts": {
    "build": "tsc -p .",
    "test": "node --import tsx --test test/**/*.test.ts",
    "start": "tsx src/server.ts",
    "report": "tsx bin/report.ts"
  },
  "dependencies": {
    "@typesafe-ai/sdk": "^0.6.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false
  },
  "include": ["src/**/*.ts", "bin/**/*.ts"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
*.jsonl
.env
```

- [ ] **Step 4: Create `LICENSE`**

```
MIT License

Copyright (c) 2026 typesafe-claude-router contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: installs without error, creates `node_modules/` and `package-lock.json`.

- [ ] **Step 6: Write the smoke test**

`test/smoke.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("smoke: test harness runs", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 7: Run tests to verify the harness works**

Run: `npm test`
Expected: PASS (1 test).

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json .gitignore LICENSE package-lock.json test/smoke.test.ts
git commit -m "chore: scaffold project (package.json, tsconfig, test harness)"
```

---

### Task 2: Shared types and pricing config

**Files:**
- Create: `src/types.ts`
- Create: `src/pricing.ts`
- Test: `test/pricing.test.ts`

**Interfaces:**
- Produces: `Tier` (`"haiku" | "sonnet" | "opus" | "fable"`), `TIER_ORDER: readonly Tier[]`, `PricingRates { inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok }`, `PricingConfig { rates: Record<Tier, PricingRates>; modelAlias: Record<Tier, string> }`, `ClassifyResult { choice: Tier; confidence: number; probabilities: Record<Tier, number> }`, `ConversationState { currentTier: Tier; turnsOnCurrentTier: number; lastPrefixTokens: number; lastNewTokens: number; lastOutputTokens: number; lastMessageCount: number; lastMessages: unknown[] }`, `Decision` (discriminated union — see Task 6), `DEFAULT_PRICING: PricingConfig`, `tierForModel(pricing: PricingConfig, model: string): Tier | null`.
- Consumes: nothing (foundational module).

- [ ] **Step 1: Write the failing test**

`test/pricing.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PRICING, tierForModel } from "../src/pricing.js";

test("tierForModel resolves a configured model alias back to its tier", () => {
  const model = DEFAULT_PRICING.modelAlias.haiku;
  assert.equal(tierForModel(DEFAULT_PRICING, model), "haiku");
});

test("tierForModel returns null for an unknown model string", () => {
  assert.equal(tierForModel(DEFAULT_PRICING, "not-a-real-model"), null);
});

test("cache read/write rates are derived consistently from input rate", () => {
  for (const tier of ["haiku", "sonnet", "opus", "fable"] as const) {
    const rates = DEFAULT_PRICING.rates[tier];
    assert.ok(Math.abs(rates.cacheReadPerMTok - rates.inputPerMTok * 0.1) < 1e-9);
    assert.ok(Math.abs(rates.cacheWritePerMTok - rates.inputPerMTok * 1.25) < 1e-9);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/pricing.js'`.

- [ ] **Step 3: Write `src/types.ts`**

```ts
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
}

export type Decision =
  | { kind: "held" }
  | { kind: "downgraded"; to: Tier; breakEvenTurns: number }
  | { kind: "downgraded-on-reset"; to: Tier }
  | { kind: "upgraded-on-reset"; to: Tier }
  | { kind: "upgrade-suggested"; to: Tier; estimatedCostUsd: number };
```

- [ ] **Step 4: Write `src/pricing.ts`**

```ts
import type { PricingConfig, Tier } from "./types.js";

// Source: web research 2026-09-19 (Claude API list pricing: Haiku 4.5 $1/$5,
// Sonnet 5 $2/$10, Opus 5 $5/$25, Fable 5.1 $10/$50 per Mtok in/out; cache
// read = 0.1x input, cache write (5m TTL) = 1.25x input, per Anthropic's
// prompt-caching pricing). Verify against current pricing before trusting
// real spend numbers — see README.
function ratesFromInput(inputPerMTok: number, outputPerMTok: number) {
  return {
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok: inputPerMTok * 0.1,
    cacheWritePerMTok: inputPerMTok * 1.25,
  };
}

export const DEFAULT_PRICING: PricingConfig = {
  rates: {
    haiku: ratesFromInput(1, 5),
    sonnet: ratesFromInput(2, 10),
    opus: ratesFromInput(5, 25),
    fable: ratesFromInput(10, 50),
  },
  modelAlias: {
    haiku: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "claude-haiku-4-5",
    sonnet: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? "claude-sonnet-5",
    opus: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? "claude-opus-5",
    fable: process.env.ANTHROPIC_DEFAULT_FABLE_MODEL ?? "claude-fable-5-1",
  },
};

export function tierForModel(pricing: PricingConfig, model: string): Tier | null {
  const entry = (Object.entries(pricing.modelAlias) as [Tier, string][]).find(
    ([, m]) => m === model
  );
  return entry ? entry[0] : null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all pricing tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/pricing.ts test/pricing.test.ts
git commit -m "feat: add shared types and pricing config"
```

---

### Task 3: Reset detection

**Files:**
- Create: `src/reset.ts`
- Test: `test/reset.test.ts`

**Interfaces:**
- Consumes: nothing beyond plain arrays/objects.
- Produces: `detectReset(lastMessages: unknown[] | undefined, currentMessages: unknown[]): boolean`.

- [ ] **Step 1: Write the failing test**

`test/reset.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectReset } from "../src/reset.js";

test("detects reset on the very first turn (no prior messages)", () => {
  assert.equal(detectReset(undefined, [{ role: "user", content: "hi" }]), true);
  assert.equal(detectReset([], [{ role: "user", content: "hi" }]), true);
});

test("detects reset when history got shorter (compact/clear)", () => {
  const last = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];
  const current = [{ role: "user", content: "summary" }];
  assert.equal(detectReset(last, current), true);
});

test("detects reset when the tracked prefix no longer matches", () => {
  const last = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
  const current = [
    { role: "user", content: "a-but-different" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];
  assert.equal(detectReset(last, current), true);
});

test("does not flag a normal append-only turn as a reset", () => {
  const last = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
  const current = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];
  assert.equal(detectReset(last, current), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/reset.js'`.

- [ ] **Step 3: Write `src/reset.ts`**

```ts
export function detectReset(
  lastMessages: unknown[] | undefined,
  currentMessages: unknown[]
): boolean {
  if (!lastMessages || lastMessages.length === 0) return true;
  if (currentMessages.length < lastMessages.length) return true;
  for (let i = 0; i < lastMessages.length; i++) {
    if (JSON.stringify(currentMessages[i]) !== JSON.stringify(lastMessages[i])) {
      return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all reset tests).

- [ ] **Step 5: Commit**

```bash
git add src/reset.ts test/reset.test.ts
git commit -m "feat: add reset detection for free-window tier switches"
```

---

### Task 4: Probability margins

**Files:**
- Create: `src/margins.ts`
- Test: `test/margins.test.ts`

**Interfaces:**
- Consumes: `Tier`, `TIER_ORDER` from `src/types.ts`.
- Produces: `MarginResult { downgradeCandidate: Tier | null; downgradeMargin: number; upgradeCandidate: Tier | null; upgradeMargin: number }`, `computeMargins(probabilities: Record<Tier, number>, currentTier: Tier): MarginResult`.

- [ ] **Step 1: Write the failing test**

`test/margins.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMargins } from "../src/margins.js";

test("finds the strongest cheaper and pricier candidates relative to current tier", () => {
  const result = computeMargins(
    { haiku: 0.5, sonnet: 0.35, opus: 0.1, fable: 0.05 },
    "sonnet"
  );
  assert.equal(result.downgradeCandidate, "haiku");
  assert.ok(Math.abs(result.downgradeMargin - (0.5 - 0.35)) < 1e-9);
  assert.equal(result.upgradeCandidate, "opus");
  assert.ok(Math.abs(result.upgradeMargin - (0.1 - 0.35)) < 1e-9);
});

test("has no downgrade candidate when current tier is already the cheapest", () => {
  const result = computeMargins(
    { haiku: 0.6, sonnet: 0.2, opus: 0.15, fable: 0.05 },
    "haiku"
  );
  assert.equal(result.downgradeCandidate, null);
  assert.equal(result.downgradeMargin, -Infinity);
  assert.equal(result.upgradeCandidate, "sonnet");
});

test("has no upgrade candidate when current tier is already the priciest", () => {
  const result = computeMargins(
    { haiku: 0.1, sonnet: 0.15, opus: 0.25, fable: 0.5 },
    "fable"
  );
  assert.equal(result.upgradeCandidate, null);
  assert.equal(result.upgradeMargin, -Infinity);
  assert.equal(result.downgradeCandidate, "opus");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/margins.js'`.

- [ ] **Step 3: Write `src/margins.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all margins tests).

- [ ] **Step 5: Commit**

```bash
git add src/margins.ts test/margins.test.ts
git commit -m "feat: compare TypeSafe probabilities pairwise against current tier"
```

---

### Task 5: Switch-tax break-even math

**Files:**
- Create: `src/breakEven.ts`
- Test: `test/breakEven.test.ts`

**Interfaces:**
- Consumes: `Tier`, `PricingConfig` from `src/types.ts`.
- Produces: `switchTax(lastPrefixTokens: number, lastNewTokens: number, lastOutputTokens: number, currentTier: Tier, candidateTier: Tier, pricing: PricingConfig): number` and `breakEvenTurns(lastPrefixTokens: number, lastNewTokens: number, lastOutputTokens: number, currentTier: Tier, candidateTier: Tier, pricing: PricingConfig): number`.

This must account for the whole turn's cost, not just the cached-prefix
line item: at realistic Claude Code token counts, the new/output tokens
each turn carries are not negligible next to the cache-rate delta, and a
prefix-only version of this math gives a materially different (and wrong)
answer — see the design spec's "Policy" section for the worked numbers.

- [ ] **Step 1: Write the failing test**

`test/breakEven.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { breakEvenTurns, switchTax } from "../src/breakEven.js";
import { DEFAULT_PRICING } from "../src/pricing.js";

test("matches the design spec's worked example: ~3.2 turns to break even, sonnet -> haiku, 20k prefix / 1k new / 500 output", () => {
  const turns = breakEvenTurns(20_000, 1_000, 500, "sonnet", "haiku", DEFAULT_PRICING);
  assert.ok(turns > 3 && turns < 3.3, `expected ~3.18, got ${turns}`);
});

test("a steep price drop (opus -> haiku) pays back in well under one turn", () => {
  const turns = breakEvenTurns(20_000, 1_000, 500, "opus", "haiku", DEFAULT_PRICING);
  assert.ok(turns < 1, `expected well under 1, got ${turns}`);
});

test("returns Infinity when the candidate tier is not actually cheaper to read", () => {
  const turns = breakEvenTurns(20_000, 1_000, 500, "haiku", "sonnet", DEFAULT_PRICING);
  assert.equal(turns, Infinity);
});

test("switchTax for an upgrade is positive (spending more never pays for itself in cache terms)", () => {
  const tax = switchTax(20_000, 1_000, 500, "sonnet", "opus", DEFAULT_PRICING);
  assert.ok(Math.abs(tax - 0.1315) < 0.0005, `expected ~0.1315, got ${tax}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/breakEven.js'`.

- [ ] **Step 3: Write `src/breakEven.ts`**

```ts
import type { PricingConfig, Tier } from "./types.js";

type CacheField = "cacheReadPerMTok" | "cacheWritePerMTok";

function turnCost(
  tier: Tier,
  cacheTokens: number,
  cacheField: CacheField,
  newTokens: number,
  outputTokens: number,
  pricing: PricingConfig
): number {
  const rates = pricing.rates[tier];
  return (
    (cacheTokens * rates[cacheField] +
      newTokens * rates.inputPerMTok +
      outputTokens * rates.outputPerMTok) /
    1_000_000
  );
}

export function switchTax(
  lastPrefixTokens: number,
  lastNewTokens: number,
  lastOutputTokens: number,
  currentTier: Tier,
  candidateTier: Tier,
  pricing: PricingConfig
): number {
  const switchTurnCost = turnCost(
    candidateTier,
    lastPrefixTokens,
    "cacheWritePerMTok",
    lastNewTokens,
    lastOutputTokens,
    pricing
  );
  const stayTurnCost = turnCost(
    currentTier,
    lastPrefixTokens,
    "cacheReadPerMTok",
    lastNewTokens,
    lastOutputTokens,
    pricing
  );
  return switchTurnCost - stayTurnCost;
}

export function breakEvenTurns(
  lastPrefixTokens: number,
  lastNewTokens: number,
  lastOutputTokens: number,
  currentTier: Tier,
  candidateTier: Tier,
  pricing: PricingConfig
): number {
  const tax = switchTax(
    lastPrefixTokens,
    lastNewTokens,
    lastOutputTokens,
    currentTier,
    candidateTier,
    pricing
  );
  const stayTurnCost = turnCost(
    currentTier,
    lastPrefixTokens,
    "cacheReadPerMTok",
    lastNewTokens,
    lastOutputTokens,
    pricing
  );
  const candidateSteadyCost = turnCost(
    candidateTier,
    lastPrefixTokens,
    "cacheReadPerMTok",
    lastNewTokens,
    lastOutputTokens,
    pricing
  );
  const perTurnSavings = stayTurnCost - candidateSteadyCost;
  if (perTurnSavings <= 0) return Infinity;
  return tax / perTurnSavings;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS. The break-even point is not a flat "~3 turns" across all tier pairs — it scales with how big the price gap is. A steep drop (Opus→Haiku, 5x) pays back in well under one turn; a shallow one (Sonnet→Haiku, 2x) sits right around the 3-turn line, which is exactly why `STICKY_ASSUMPTION = 3` (Task 6) will hold on some profitable-looking margins and switch on others — that's intended, not a bug.

- [ ] **Step 5: Commit**

```bash
git add src/breakEven.ts test/breakEven.test.ts
git commit -m "feat: add cache-miss switch-tax break-even math over the whole turn"
```

---

### Task 6: Policy orchestration

**Files:**
- Create: `src/policy.ts`
- Test: `test/policy.test.ts`

**Interfaces:**
- Consumes: `Tier`, `TIER_ORDER`, `ClassifyResult`, `ConversationState`, `Decision`, `PricingConfig` from `src/types.ts`; `detectReset` from `src/reset.ts`; `computeMargins` from `src/margins.ts`; `breakEvenTurns`, `switchTax` from `src/breakEven.ts`.
- Produces: `MARGIN_THRESHOLD = 0.1`, `STICKY_ASSUMPTION = 3`, `decide(classification: ClassifyResult, state: ConversationState, currentMessages: unknown[], pricing: PricingConfig): Decision`.

All test scenarios below use the same `lastPrefixTokens: 20_000,
lastNewTokens: 1_000, lastOutputTokens: 500` state, matching the design
spec's worked example and Task 5's tests, so the expected outcomes below
are the same real numbers Task 5 already established — not estimates.

- [ ] **Step 1: Write the failing test**

`test/policy.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/policy.js";
import { DEFAULT_PRICING } from "../src/pricing.js";
import type { ConversationState, ClassifyResult } from "../src/types.js";

function state(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    currentTier: "sonnet",
    turnsOnCurrentTier: 5,
    lastPrefixTokens: 20_000,
    lastNewTokens: 1_000,
    lastOutputTokens: 500,
    lastMessageCount: 2,
    lastMessages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }],
    ...overrides,
  };
}

const currentMessages = [
  { role: "user", content: "a" },
  { role: "assistant", content: "b" },
  { role: "user", content: "c" },
];

test("holds when neither margin clears the threshold", () => {
  const classification: ClassifyResult = {
    choice: "sonnet",
    confidence: 0.4,
    probabilities: { haiku: 0.15, sonnet: 0.4, opus: 0.35, fable: 0.1 },
  };
  const decision = decide(classification, state(), currentMessages, DEFAULT_PRICING);
  assert.deepEqual(decision, { kind: "held" });
});

test("downgrades automatically on a steep price drop (opus -> haiku) whose break-even is well under STICKY_ASSUMPTION", () => {
  const classification: ClassifyResult = {
    choice: "haiku",
    confidence: 0.6,
    probabilities: { haiku: 0.6, sonnet: 0.05, opus: 0.3, fable: 0.05 },
  };
  const decision = decide(
    classification,
    state({ currentTier: "opus" }),
    currentMessages,
    DEFAULT_PRICING
  );
  assert.equal(decision.kind, "downgraded");
  if (decision.kind === "downgraded") {
    assert.equal(decision.to, "haiku");
    assert.ok(decision.breakEvenTurns < 1, `expected well under 1, got ${decision.breakEvenTurns}`);
  }
});

test("declines a shallow-drop downgrade (sonnet -> haiku) whose break-even exceeds STICKY_ASSUMPTION", () => {
  // Task 5 established sonnet -> haiku break-even at these token counts is
  // ~3.18 turns, just over the default STICKY_ASSUMPTION of 3 -- this is
  // the design spec's central point: a 2x price gap isn't automatically
  // worth a cache-miss tax the way a 5x gap (opus -> haiku, above) is.
  const classification: ClassifyResult = {
    choice: "haiku",
    confidence: 0.5,
    probabilities: { haiku: 0.5, sonnet: 0.3, opus: 0.15, fable: 0.05 },
  };
  const decision = decide(classification, state(), currentMessages, DEFAULT_PRICING);
  assert.deepEqual(decision, { kind: "held" });
});

test("never auto-switches on an upgrade outside a reset window; suggests instead, with the real switch-tax as the estimated cost", () => {
  const classification: ClassifyResult = {
    choice: "opus",
    confidence: 0.7,
    probabilities: { haiku: 0.05, sonnet: 0.15, opus: 0.7, fable: 0.1 },
  };
  const decision = decide(classification, state(), currentMessages, DEFAULT_PRICING);
  assert.equal(decision.kind, "upgrade-suggested");
  if (decision.kind === "upgrade-suggested") {
    assert.equal(decision.to, "opus");
    assert.ok(Math.abs(decision.estimatedCostUsd - 0.1315) < 0.0005);
  }
});

test("on reset, adopts the argmax choice immediately with no margin or break-even check, downgrade direction", () => {
  const classification: ClassifyResult = {
    choice: "haiku",
    confidence: 0.34,
    probabilities: { haiku: 0.34, sonnet: 0.33, opus: 0.17, fable: 0.16 },
  };
  const resetState = state({ lastMessages: [], lastMessageCount: 0 });
  const decision = decide(classification, resetState, currentMessages, DEFAULT_PRICING);
  assert.deepEqual(decision, { kind: "downgraded-on-reset", to: "haiku" });
});

test("on reset, adopts the argmax choice immediately, upgrade direction", () => {
  const classification: ClassifyResult = {
    choice: "opus",
    confidence: 0.4,
    probabilities: { haiku: 0.1, sonnet: 0.3, opus: 0.4, fable: 0.2 },
  };
  const resetState = state({ lastMessages: [], lastMessageCount: 0 });
  const decision = decide(classification, resetState, currentMessages, DEFAULT_PRICING);
  assert.deepEqual(decision, { kind: "upgraded-on-reset", to: "opus" });
});

test("on reset, holds when the argmax choice equals the current tier", () => {
  const classification: ClassifyResult = {
    choice: "sonnet",
    confidence: 0.4,
    probabilities: { haiku: 0.2, sonnet: 0.4, opus: 0.3, fable: 0.1 },
  };
  const resetState = state({ lastMessages: [], lastMessageCount: 0 });
  const decision = decide(classification, resetState, currentMessages, DEFAULT_PRICING);
  assert.deepEqual(decision, { kind: "held" });
});

test("when both a downgrade and an upgrade candidate clear the threshold, the larger margin wins (downgrade), and it clears break-even too", () => {
  const classification: ClassifyResult = {
    choice: "haiku",
    confidence: 0.45,
    probabilities: { haiku: 0.45, sonnet: 0.05, opus: 0.15, fable: 0.35 },
  };
  // downgradeMargin = 0.45 - 0.15 = 0.30; upgradeMargin (fable) = 0.35 - 0.15 = 0.20
  const decision = decide(
    classification,
    state({ currentTier: "opus" }),
    currentMessages,
    DEFAULT_PRICING
  );
  assert.equal(decision.kind, "downgraded");
  if (decision.kind === "downgraded") assert.equal(decision.to, "haiku");
});

test("when both clear the threshold, the larger margin wins (upgrade)", () => {
  const classification: ClassifyResult = {
    choice: "opus",
    confidence: 0.58,
    probabilities: { haiku: 0.22, sonnet: 0.1, opus: 0.58, fable: 0.1 },
  };
  // downgradeMargin (haiku, the only cheaper tier) = 0.22 - 0.1 = 0.12
  // upgradeMargin (opus, strongest pricier tier) = 0.58 - 0.1 = 0.48
  const decision = decide(classification, state(), currentMessages, DEFAULT_PRICING);
  assert.equal(decision.kind, "upgrade-suggested");
  if (decision.kind === "upgrade-suggested") assert.equal(decision.to, "opus");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/policy.js'`.

- [ ] **Step 3: Write `src/policy.ts`**

```ts
import { TIER_ORDER, type ClassifyResult, type ConversationState, type Decision, type PricingConfig } from "./types.js";
import { detectReset } from "./reset.js";
import { computeMargins } from "./margins.js";
import { breakEvenTurns, switchTax } from "./breakEven.js";

export const MARGIN_THRESHOLD = 0.1;
export const STICKY_ASSUMPTION = 3;

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all policy tests). If a downgrade test doesn't come out as expected, check which tier pair it uses against Task 5's break-even numbers first — a 2x price gap (sonnet↔haiku) and a 5x gap (opus/fable↔haiku) behave very differently under the same `STICKY_ASSUMPTION`, by design.

- [ ] **Step 5: Commit**

```bash
git add src/policy.ts test/policy.test.ts
git commit -m "feat: orchestrate reset detection, margins, and break-even into decide()"
```

---

### Task 7: Per-connection conversation state

**Files:**
- Create: `src/conversationKey.ts`
- Test: `test/conversationKey.test.ts`

**Interfaces:**
- Consumes: `ConversationState`, `Tier` from `src/types.ts`; Node's `net.Socket` type.
- Produces: `getOrInitState(socket: object, initialTier: Tier): ConversationState`, `updateState(state: ConversationState, decisionTier: Tier, usage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }, currentMessages: unknown[]): void`.

- [ ] **Step 1: Write the failing test**

`test/conversationKey.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getOrInitState, updateState } from "../src/conversationKey.js";

test("initializes state on first use and returns the same object on reuse", () => {
  const socket = {};
  const first = getOrInitState(socket, "sonnet");
  assert.equal(first.currentTier, "sonnet");
  assert.equal(first.turnsOnCurrentTier, 0);
  assert.equal(first.lastNewTokens, 0);
  assert.equal(first.lastOutputTokens, 0);
  const second = getOrInitState(socket, "haiku");
  assert.equal(second, first);
  assert.equal(second.currentTier, "sonnet");
});

test("two different sockets never share state", () => {
  const a = getOrInitState({}, "sonnet");
  const b = getOrInitState({}, "sonnet");
  updateState(
    a,
    "haiku",
    { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
    [{ role: "user", content: "x" }]
  );
  assert.equal(a.currentTier, "haiku");
  assert.equal(b.currentTier, "sonnet");
});

test("updateState advances tier, turn count, prefix/new/output tokens, and tracked messages", () => {
  const state = getOrInitState({}, "sonnet");
  const messages = [{ role: "user", content: "x" }, { role: "assistant", content: "y" }];
  updateState(
    state,
    "haiku",
    {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 1500,
    },
    messages
  );
  assert.equal(state.currentTier, "haiku");
  assert.equal(state.turnsOnCurrentTier, 1);
  assert.equal(state.lastPrefixTokens, 2000);
  assert.equal(state.lastNewTokens, 1000);
  assert.equal(state.lastOutputTokens, 500);
  assert.equal(state.lastMessageCount, 2);
  assert.deepEqual(state.lastMessages, messages);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/conversationKey.js'`.

- [ ] **Step 3: Write `src/conversationKey.ts`**

```ts
import type { ConversationState, Tier } from "./types.js";

const store = new WeakMap<object, ConversationState>();

export function getOrInitState(socket: object, initialTier: Tier): ConversationState {
  let state = store.get(socket);
  if (!state) {
    state = {
      currentTier: initialTier,
      turnsOnCurrentTier: 0,
      lastPrefixTokens: 0,
      lastNewTokens: 0,
      lastOutputTokens: 0,
      lastMessageCount: 0,
      lastMessages: [],
    };
    store.set(socket, state);
  }
  return state;
}

export function updateState(
  state: ConversationState,
  decisionTier: Tier,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  },
  currentMessages: unknown[]
): void {
  state.currentTier = decisionTier;
  state.turnsOnCurrentTier += 1;
  state.lastPrefixTokens =
    (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  state.lastNewTokens = usage.input_tokens ?? 0;
  state.lastOutputTokens = usage.output_tokens ?? 0;
  state.lastMessageCount = currentMessages.length;
  state.lastMessages = currentMessages;
}
```

Note: `WeakMap` keys on object identity, so a real `net.Socket` works directly — no explicit cleanup needed, entries are garbage-collected once the socket is no longer referenced elsewhere (e.g. after it closes and Node drops it).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all conversationKey tests).

- [ ] **Step 5: Commit**

```bash
git add src/conversationKey.ts test/conversationKey.test.ts
git commit -m "feat: track routing state per TCP connection, not by content hash"
```

---

### Task 8: TypeSafe classifier wrapper

**Files:**
- Create: `src/classify.ts`
- Test: `test/classify.test.ts`

**Interfaces:**
- Consumes: `Tier`, `ClassifyResult` from `src/types.ts`; `@typesafe-ai/sdk`'s `choice` and `TypeSafeClient`.
- Produces: `ClassifyInput { recentMessages: unknown[]; latestUserMessage: string }`, `classifyTurn(input: ClassifyInput, options?: { timeoutMs?: number; call?: (args: unknown) => Promise<unknown> }): Promise<ClassifyResult | null>`. The `call` option lets callers (including tests and `server.ts`) inject a stand-in for the real TypeSafe request.

- [ ] **Step 1: Write the failing test**

`test/classify.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTurn } from "../src/classify.js";

function fakeResponse(choiceValue: string) {
  return {
    answers: {
      tier: {
        type: "choice",
        choice: choiceValue,
        confidence: 0.8,
        probabilities: { haiku: 0.1, sonnet: 0.1, opus: 0.7, fable: 0.1 },
      },
    },
  };
}

test("maps a successful TypeSafe response to a ClassifyResult", async () => {
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "fix this hard bug" },
    { call: async () => fakeResponse("opus") }
  );
  assert.deepEqual(result, {
    choice: "opus",
    confidence: 0.8,
    probabilities: { haiku: 0.1, sonnet: 0.1, opus: 0.7, fable: 0.1 },
  });
});

test("returns null when the call rejects", async () => {
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "x" },
    { call: async () => { throw new Error("network error"); } }
  );
  assert.equal(result, null);
});

test("returns null when the call exceeds the timeout budget", async () => {
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "x" },
    {
      timeoutMs: 20,
      call: () => new Promise((resolve) => setTimeout(() => resolve(fakeResponse("haiku")), 500)),
    }
  );
  assert.equal(result, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/classify.js'`.

- [ ] **Step 3: Write `src/classify.ts`**

```ts
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type { ClassifyResult, Tier } from "./types.js";

let client: TypeSafeClient | undefined;

function getClient(): TypeSafeClient {
  if (!client) client = new TypeSafeClient();
  return client;
}

const TIER_CRITERIA = {
  haiku:
    "Mechanical or trivial: reading a file, running a known command, a simple factual question, a small well-specified edit.",
  sonnet:
    "Typical software engineering task: multi-file changes, moderate reasoning, normal debugging.",
  opus:
    "Hard reasoning: ambiguous requirements, tricky debugging, architectural decisions, multi-step planning.",
  fable:
    "Exceptionally demanding: the task explicitly calls for the deepest available reasoning or highest-stakes correctness.",
};

export interface ClassifyInput {
  recentMessages: unknown[];
  latestUserMessage: string;
}

type SystemOneCall = (args: unknown) => Promise<any>;

function defaultCall(args: unknown): Promise<any> {
  return getClient().systemOne(args as never);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("typesafe_timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export async function classifyTurn(
  input: ClassifyInput,
  options: { timeoutMs?: number; call?: SystemOneCall } = {}
): Promise<ClassifyResult | null> {
  const { timeoutMs = 2000, call = defaultCall } = options;
  try {
    const response = await withTimeout(
      call({
        state: {
          recentMessages: input.recentMessages,
          latestUserMessage: input.latestUserMessage,
        },
        questions: {
          tier: choice(
            "Which model tier does this turn actually need, given the recent conversation and the latest user message?",
            TIER_CRITERIA
          ),
        },
      }),
      timeoutMs
    );
    const answer = response.answers.tier;
    return {
      choice: answer.choice as Tier,
      confidence: answer.confidence,
      probabilities: answer.probabilities as Record<Tier, number>,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all classify tests). These tests never contact the real TypeSafe API — they inject `call` directly, per the "Testing mode: live keys available" decision, live-API verification happens in the manual end-to-end pass (Task 13), not in the automated suite. The client is constructed lazily (`getClient()`), not at module load — `new TypeSafeClient()` throws immediately if `TYPESAFE_API_KEY` isn't set, and an eager top-level instantiation would crash on import before a test ever got the chance to inject its own `call`.

- [ ] **Step 5: Commit**

```bash
git add src/classify.ts test/classify.test.ts
git commit -m "feat: wrap TypeSafe Jev Choice call with timeout and fail-open behavior"
```

---

### Task 9: Upgrade suggestion note

**Files:**
- Create: `src/upgradeNote.ts`
- Test: `test/upgradeNote.test.ts`

**Interfaces:**
- Consumes: `Tier` from `src/types.ts`.
- Produces: `buildUpgradeNoteBlock(tier: Tier, estimatedCostUsd: number): { type: "text"; text: string }`.

- [ ] **Step 1: Write the failing test**

`test/upgradeNote.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpgradeNoteBlock } from "../src/upgradeNote.js";

test("produces a text content block naming the tier and cost", () => {
  const block = buildUpgradeNoteBlock("opus", 0.0287);
  assert.equal(block.type, "text");
  assert.match(block.text, /opus/);
  assert.match(block.text, /\$0\.0287/);
  assert.match(block.text, /\/model opus/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/upgradeNote.js'`.

- [ ] **Step 3: Write `src/upgradeNote.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/upgradeNote.ts test/upgradeNote.test.ts
git commit -m "feat: build the injected upgrade-suggestion content block"
```

---

### Task 10: Cost ledger

**Files:**
- Create: `src/ledger.ts`
- Test: `test/ledger.test.ts`

**Interfaces:**
- Consumes: `Tier`, `PricingConfig` from `src/types.ts`; Node's `node:fs`.
- Produces: `LedgerLine` (see below), `appendLedgerLine(path: string, line: LedgerLine): void`, `readLedger(path: string): LedgerLine[]`, `computeCostUsd(pricing: PricingConfig, tier: Tier, inputTokens: number, outputTokens: number, cacheCreationTokens: number, cacheReadTokens: number): number`.

- [ ] **Step 1: Write the failing test**

`test/ledger.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedgerLine, readLedger, computeCostUsd, type LedgerLine } from "../src/ledger.js";
import { DEFAULT_PRICING } from "../src/pricing.js";

function line(overrides: Partial<LedgerLine> = {}): LedgerLine {
  return {
    ts: new Date().toISOString(),
    conversationKey: "socket",
    probabilities: { haiku: 0.1, sonnet: 0.8, opus: 0.05, fable: 0.05 },
    downgradeMargin: -0.05,
    upgradeMargin: -0.75,
    decision: "held",
    resetDetected: false,
    suggestedUpgradeTo: null,
    suggestedUpgradeCostUsd: null,
    actualModel: DEFAULT_PRICING.modelAlias.sonnet,
    actualTier: "sonnet",
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 20000,
    actualCostUsd: 0.011,
    counterfactualNoRoutingCostUsd: 0.011,
    ...overrides,
  };
}

test("readLedger returns an empty array when the file does not exist", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "missing.jsonl");
  assert.deepEqual(readLedger(path), []);
});

test("appendLedgerLine writes JSONL that readLedger parses back", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  appendLedgerLine(path, line({ decision: "downgraded" }));
  appendLedgerLine(path, line({ decision: "held" }));
  const lines = readLedger(path);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].decision, "downgraded");
  assert.equal(lines[1].decision, "held");
});

test("computeCostUsd sums input, output, cache-write, and cache-read tokens at their own rates", () => {
  const cost = computeCostUsd(DEFAULT_PRICING, "sonnet", 1000, 500, 0, 20000);
  const expected =
    (1000 * 2 + 500 * 10 + 0 * 2.5 + 20000 * 0.2) / 1_000_000;
  assert.ok(Math.abs(cost - expected) < 1e-9);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/ledger.js'`.

- [ ] **Step 3: Write `src/ledger.ts`**

```ts
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { PricingConfig, Tier } from "./types.js";

export interface LedgerLine {
  ts: string;
  conversationKey: string;
  probabilities: Record<Tier, number>;
  downgradeMargin: number;
  upgradeMargin: number;
  decision: string;
  resetDetected: boolean;
  suggestedUpgradeTo: Tier | null;
  suggestedUpgradeCostUsd: number | null;
  actualModel: string;
  actualTier: Tier;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  actualCostUsd: number;
  counterfactualNoRoutingCostUsd: number;
}

export function appendLedgerLine(path: string, line: LedgerLine): void {
  appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
}

export function readLedger(path: string): LedgerLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LedgerLine);
}

export function computeCostUsd(
  pricing: PricingConfig,
  tier: Tier,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number
): number {
  const rates = pricing.rates[tier];
  return (
    (inputTokens * rates.inputPerMTok +
      outputTokens * rates.outputPerMTok +
      cacheCreationTokens * rates.cacheWritePerMTok +
      cacheReadTokens * rates.cacheReadPerMTok) /
    1_000_000
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all ledger tests).

- [ ] **Step 5: Commit**

```bash
git add src/ledger.ts test/ledger.test.ts
git commit -m "feat: add JSONL cost ledger with real-usage cost computation"
```

---

### Task 11: Proxy server

**Files:**
- Create: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `getOrInitState`/`updateState` from `src/conversationKey.ts`; `decide` from `src/policy.ts`; `computeMargins` from `src/margins.ts`; `classifyTurn`, `ClassifyInput` from `src/classify.ts`; `DEFAULT_PRICING`, `tierForModel` from `src/pricing.ts`; `appendLedgerLine`, `computeCostUsd` from `src/ledger.ts`; `buildUpgradeNoteBlock` from `src/upgradeNote.ts`; `PricingConfig`, `Tier`, `ClassifyResult` from `src/types.ts`.
- Produces: `ServerOptions { upstream?: string; mode?: "shadow" | "live"; ledgerPath?: string; pricing?: PricingConfig; classify?: (input: ClassifyInput) => Promise<ClassifyResult | null> }`, `handleMessages(req, res, options?: ServerOptions): Promise<void>`, `createProxyServer(options?: ServerOptions): http.Server`.

- [ ] **Step 1: Write the failing test**

`test/server.test.ts` spins up two real local HTTP servers: a fake "upstream Anthropic" that echoes back a canned response with a `usage` block, and the router itself pointed at that fake upstream with an injected `classify` — then makes a real HTTP request through the router and asserts on what came out the other side and what got logged.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer } from "../src/server.js";
import { readLedger } from "../src/ledger.js";
import { DEFAULT_PRICING } from "../src/pricing.js";

function listen(server: import("node:http").Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      if (typeof address === "object" && address) resolve(address.port);
    });
  });
}

async function withFakeUpstream(
  respond: (body: any) => { status: number; usage: Record<string, number>; text: string }
) {
  let lastBody: any = null;
  const fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const { status, usage, text } = respond(lastBody);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text }], usage }));
    });
  });
  const port = await listen(fake);
  return { url: `http://127.0.0.1:${port}`, close: () => fake.close(), getLastBody: () => lastBody };
}

test("holds tier, passes model through untouched, and logs real usage", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 20000 },
    text: "ok",
  }));

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    mode: "live",
    ledgerPath,
    classify: async () => ({
      choice: "sonnet",
      confidence: 0.8,
      probabilities: { haiku: 0.05, sonnet: 0.8, opus: 0.1, fable: 0.05 },
    }),
  });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(fake.getLastBody().model, DEFAULT_PRICING.modelAlias.sonnet);

  const lines = readLedger(ledgerPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].decision, "held");
  assert.equal(lines[0].inputTokens, 1000);
  assert.equal(lines[0].cacheReadTokens, 20000);

  router.close();
  fake.close();
});

test("rewrites the model field in live mode on a reset-window downgrade", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
    text: "ok",
  }));

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    mode: "live",
    ledgerPath,
    classify: async () => ({
      choice: "haiku",
      confidence: 0.9,
      probabilities: { haiku: 0.9, sonnet: 0.05, opus: 0.03, fable: 0.02 },
    }),
  });
  const port = await listen(router);

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      messages: [{ role: "user", content: "first turn on this connection" }],
    }),
  });

  assert.equal(fake.getLastBody().model, DEFAULT_PRICING.modelAlias.haiku);

  const lines = readLedger(ledgerPath);
  assert.equal(lines[0].decision, "downgraded-on-reset");

  router.close();
  fake.close();
});

test("shadow mode never rewrites the model even when the policy would switch", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
    text: "ok",
  }));

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    mode: "shadow",
    ledgerPath,
    classify: async () => ({
      choice: "haiku",
      confidence: 0.9,
      probabilities: { haiku: 0.9, sonnet: 0.05, opus: 0.03, fable: 0.02 },
    }),
  });
  const port = await listen(router);

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      messages: [{ role: "user", content: "first turn" }],
    }),
  });

  assert.equal(fake.getLastBody().model, DEFAULT_PRICING.modelAlias.sonnet);
  const lines = readLedger(ledgerPath);
  assert.equal(lines[0].decision, "downgraded-on-reset");

  router.close();
  fake.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/server.js'`.

- [ ] **Step 3: Write `src/server.ts`**

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getOrInitState, updateState } from "./conversationKey.js";
import { decide } from "./policy.js";
import { computeMargins } from "./margins.js";
import { classifyTurn, type ClassifyInput } from "./classify.js";
import { DEFAULT_PRICING, tierForModel } from "./pricing.js";
import { appendLedgerLine, computeCostUsd } from "./ledger.js";
import { buildUpgradeNoteBlock } from "./upgradeNote.js";
import type { PricingConfig, Tier, ClassifyResult } from "./types.js";

export interface ServerOptions {
  upstream?: string;
  mode?: "shadow" | "live";
  ledgerPath?: string;
  pricing?: PricingConfig;
  classify?: (input: ClassifyInput) => Promise<ClassifyResult | null>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function extractLatestUserText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        const textBlock = m.content.find((b: any) => b.type === "text");
        return textBlock?.text ?? "";
      }
    }
  }
  return "";
}

export async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions = {}
): Promise<void> {
  const upstream = options.upstream ?? "https://api.anthropic.com";
  const mode = options.mode ?? (process.env.ROUTER_MODE === "live" ? "live" : "shadow");
  const ledgerPath =
    options.ledgerPath ?? process.env.ROUTER_LEDGER_PATH ?? "./router-ledger.jsonl";
  const pricing = options.pricing ?? DEFAULT_PRICING;
  const classify = options.classify ?? classifyTurn;

  const bodyBuf = await readBody(req);
  const body = JSON.parse(bodyBuf.toString("utf8"));
  const requestedModel: string = body.model;
  const initialTier: Tier = tierForModel(pricing, requestedModel) ?? "sonnet";
  const state = getOrInitState(req.socket, initialTier);

  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const latestUserMessage = extractLatestUserText(messages);

  const classification = await classify({
    recentMessages: messages.slice(-6),
    latestUserMessage,
  });

  const marginInfo = classification
    ? computeMargins(classification.probabilities, state.currentTier)
    : null;

  const decision = classification
    ? decide(classification, state, messages, pricing)
    : ({ kind: "held" } as const);

  let outgoingModel = requestedModel;
  const isSwitch =
    decision.kind === "downgraded" ||
    decision.kind === "downgraded-on-reset" ||
    decision.kind === "upgraded-on-reset";

  if (mode === "live" && isSwitch) {
    outgoingModel = pricing.modelAlias[decision.to];
    body.model = outgoingModel;
  }

  if (decision.kind === "upgrade-suggested" && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last.role === "user") {
      const note = buildUpgradeNoteBlock(decision.to, decision.estimatedCostUsd);
      const content = Array.isArray(last.content)
        ? [...last.content, note]
        : [{ type: "text", text: String(last.content ?? "") }, note];
      body.messages = [...messages.slice(0, -1), { ...last, content }];
    }
  }

  const upstreamHeaders = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") upstreamHeaders.set(key, value);
    else if (Array.isArray(value)) upstreamHeaders.set(key, value.join(", "));
  }
  upstreamHeaders.delete("host");
  upstreamHeaders.delete("content-length");

  const upstreamResponse = await fetch(`${upstream}/v1/messages`, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(body),
  });

  res.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers.entries()));

  const usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const actualModel = mode === "live" ? outgoingModel : requestedModel;
  const actualTier = tierForModel(pricing, actualModel) ?? state.currentTier;

  if (upstreamResponse.body) {
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      buffered += decoder.decode(value, { stream: true });
      for (const match of buffered.matchAll(/"usage"\s*:\s*(\{[^}]*\})/g)) {
        try {
          const parsed = JSON.parse(match[1]);
          usage.inputTokens = parsed.input_tokens ?? usage.inputTokens;
          usage.outputTokens = parsed.output_tokens ?? usage.outputTokens;
          usage.cacheCreationTokens =
            parsed.cache_creation_input_tokens ?? usage.cacheCreationTokens;
          usage.cacheReadTokens = parsed.cache_read_input_tokens ?? usage.cacheReadTokens;
        } catch {
          // partial match straddling a chunk boundary; more bytes will complete it
        }
      }
    }
  }
  res.end();

  updateState(
    state,
    actualTier,
    {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_creation_input_tokens: usage.cacheCreationTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
    },
    messages
  );

  const actualCostUsd = computeCostUsd(
    pricing,
    actualTier,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheCreationTokens,
    usage.cacheReadTokens
  );
  const counterfactualNoRoutingCostUsd = computeCostUsd(
    pricing,
    initialTier,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheCreationTokens,
    usage.cacheReadTokens
  );

  appendLedgerLine(ledgerPath, {
    ts: new Date().toISOString(),
    conversationKey: "socket",
    probabilities: classification?.probabilities ?? ({} as Record<Tier, number>),
    downgradeMargin: marginInfo?.downgradeMargin ?? 0,
    upgradeMargin: marginInfo?.upgradeMargin ?? 0,
    decision: decision.kind,
    resetDetected:
      decision.kind === "downgraded-on-reset" || decision.kind === "upgraded-on-reset",
    suggestedUpgradeTo: decision.kind === "upgrade-suggested" ? decision.to : null,
    suggestedUpgradeCostUsd:
      decision.kind === "upgrade-suggested" ? decision.estimatedCostUsd : null,
    actualModel,
    actualTier,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    actualCostUsd,
    counterfactualNoRoutingCostUsd,
  });
}

export function createProxyServer(options: ServerOptions = {}) {
  return createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/messages") {
      handleMessages(req, res, options).catch((err) => {
        console.error("router error", err);
        if (!res.headersSent) res.writeHead(502);
        res.end(JSON.stringify({ error: "router_proxy_error" }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8787);
  createProxyServer().listen(port, () => {
    const mode = process.env.ROUTER_MODE === "live" ? "live" : "shadow";
    console.log(`typesafe-claude-router listening on http://localhost:${port} (mode=${mode})`);
  });
}
```

Known limitation, documented here and in the README (Task 13): usage token counts are extracted with a regex scan over the raw streamed bytes for any `"usage": {...}` object, taking the most recently-seen value for each field. This is a pragmatic v1 approach that works for both streaming and non-streaming responses without a full SSE event-type parser, but it assumes Anthropic's `usage` objects don't span a single `matchAll` chunk boundary in a way that breaks the regex — acceptable for v1, worth revisiting if real sessions show missed usage data (see Task 13's manual validation step 2).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all server tests).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: add the proxy server tying routing, ledger, and passthrough together"
```

---

### Task 12: CLI cost report

**Files:**
- Create: `bin/report.ts`
- Test: `test/report.test.ts`

**Interfaces:**
- Consumes: `readLedger`, `LedgerLine` from `src/ledger.ts`.
- Produces: a `summarize(lines: LedgerLine[]): { turns: number; held: number; downgraded: number; upgradedOnReset: number; suggested: number; totalActualUsd: number; totalCounterfactualUsd: number; deltaUsd: number }` function (exported so the CLI's formatting logic can be tested without spawning a process), plus a `main()` that reads `process.argv`, calls `readLedger` + `summarize`, and prints the result.

- [ ] **Step 1: Write the failing test**

`test/report.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../bin/report.js";
import type { LedgerLine } from "../src/ledger.js";

function line(overrides: Partial<LedgerLine>): LedgerLine {
  return {
    ts: new Date().toISOString(),
    conversationKey: "socket",
    probabilities: { haiku: 0.25, sonnet: 0.25, opus: 0.25, fable: 0.25 },
    downgradeMargin: 0,
    upgradeMargin: 0,
    decision: "held",
    resetDetected: false,
    suggestedUpgradeTo: null,
    suggestedUpgradeCostUsd: null,
    actualModel: "claude-sonnet-5",
    actualTier: "sonnet",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    actualCostUsd: 0,
    counterfactualNoRoutingCostUsd: 0,
    ...overrides,
  };
}

test("summarize counts each decision kind and totals actual vs counterfactual cost", () => {
  const lines: LedgerLine[] = [
    line({ decision: "held", actualCostUsd: 0.01, counterfactualNoRoutingCostUsd: 0.01 }),
    line({ decision: "downgraded", actualCostUsd: 0.005, counterfactualNoRoutingCostUsd: 0.01 }),
    line({ decision: "downgraded-on-reset", actualCostUsd: 0.001, counterfactualNoRoutingCostUsd: 0.002 }),
    line({ decision: "upgraded-on-reset", actualCostUsd: 0.02, counterfactualNoRoutingCostUsd: 0.01 }),
    line({ decision: "upgrade-suggested", actualCostUsd: 0.01, counterfactualNoRoutingCostUsd: 0.01 }),
  ];
  const summary = summarize(lines);
  assert.equal(summary.turns, 5);
  assert.equal(summary.held, 1);
  assert.equal(summary.downgraded, 2);
  assert.equal(summary.upgradedOnReset, 1);
  assert.equal(summary.suggested, 1);
  assert.ok(Math.abs(summary.totalActualUsd - 0.046) < 1e-9);
  assert.ok(Math.abs(summary.totalCounterfactualUsd - 0.042) < 1e-9);
  assert.ok(Math.abs(summary.deltaUsd - (0.046 - 0.042)) < 1e-9);
});

test("summarize handles an empty ledger", () => {
  const summary = summarize([]);
  assert.equal(summary.turns, 0);
  assert.equal(summary.totalActualUsd, 0);
  assert.equal(summary.totalCounterfactualUsd, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../bin/report.js'`.

- [ ] **Step 3: Write `bin/report.ts`**

```ts
#!/usr/bin/env node
import { readLedger, type LedgerLine } from "../src/ledger.js";

export interface Summary {
  turns: number;
  held: number;
  downgraded: number;
  upgradedOnReset: number;
  suggested: number;
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
  console.log(`Actual cost:         $${s.totalActualUsd.toFixed(4)}`);
  console.log(`No-routing baseline: $${s.totalCounterfactualUsd.toFixed(4)}`);
  console.log(
    `Delta:               $${s.deltaUsd.toFixed(4)} (${s.deltaUsd < 0 ? "saved" : "cost more"})`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (all report tests).

- [ ] **Step 5: Commit**

```bash
git add bin/report.ts test/report.test.ts
git commit -m "feat: add CLI report summarizing real routing cost vs no-routing baseline"
```

---

### Task 13: Build wiring, README, and manual end-to-end validation

**Files:**
- Modify: `package.json` (bin path already points at `dist/bin/report.js` from Task 1 — verify it resolves after building)
- Create: `README.md`

**Interfaces:**
- Consumes: nothing new — this task documents and verifies what Tasks 1–12 built.

- [ ] **Step 1: Build and smoke-check the compiled output**

Run: `npm run build`
Expected: `dist/src/*.js` and `dist/bin/report.js` are created with no type errors.

Run: `node dist/bin/report.js` (no path argument)
Expected: prints the usage message and exits non-zero — confirms the compiled CLI entry point works end to end, not just under `tsx`.

- [ ] **Step 2: Write `README.md`**

```markdown
# typesafe-claude-router

A local proxy that routes Claude Code turns across model tiers
(`haiku` / `sonnet` / `opus` / `fable`) using TypeSafe's Jev `Choice`
primitive — but only when the math says it's actually worth it.

## Why this exists, and the catch

Anthropic's prompt cache is scoped per model. Claude Code resends the
full session context every turn; a cache hit bills that context at ~10%
of the input rate. Switching models discards the cache, so the very next
request on the new model reprocesses everything at the cache-*write*
rate. Naive per-message routing usually **loses** money, not saves it,
because that one-time tax outweighs a cheaper tier's per-token discount
unless you stay on it for several turns afterward.

This router is built around that constraint:
- **Downgrades** (to a cheaper tier) only happen automatically when the
  projected savings clear the one-time switch tax within a conservative
  number of turns.
- **Upgrades** (to a pricier tier) are never applied automatically —
  they're surfaced as an in-context note with the estimated cost, and
  it's your call whether to act on it.
- Both are free to apply immediately at the moments the cache was going
  to be rebuilt anyway (session start, `/clear`, `/compact`).
- Every turn's *real* token usage and cost gets logged, so you can
  measure whether routing actually helped a given session instead of
  trusting a theoretical estimate.

Full design rationale: `docs/superpowers/specs/2026-09-19-typesafe-router-design.md`.

## Setup

```bash
npm install
export TYPESAFE_API_KEY=...      # from typesafe.ai
export ANTHROPIC_API_KEY=...     # your normal Anthropic key/subscription auth
npm start                        # starts the proxy on :8787 in shadow mode
```

In another terminal, point Claude Code at it:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
claude
```

Shadow mode (the default) never changes which model actually serves a
turn — it only logs what it *would* have done. Watch `./router-ledger.jsonl`
fill in during a real session, then run:

```bash
npm run report -- ./router-ledger.jsonl
```

to see judged decisions and the real cost delta vs. never routing at all.

When you're ready to let it actually switch models:

```bash
ROUTER_MODE=live npm start
```

## Configuration

| Env var | Purpose | Default |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | TypeSafe auth (required) | — |
| `ROUTER_MODE` | `shadow` or `live` | `shadow` |
| `ROUTER_LEDGER_PATH` | Where turn-by-turn cost data is logged | `./router-ledger.jsonl` |
| `PORT` | Local proxy port | `8787` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `_SONNET_` / `_OPUS_` / `_FABLE_MODEL` | Which real model each tier maps to | see `src/pricing.ts` |

Pricing (`src/pricing.ts`) reflects research done 2026-09-19 and **will
drift** — check current Claude API pricing before trusting real spend
numbers from the report.

## Known limitations (v1)

- Conversation identity is keyed by the TCP connection Claude Code holds
  open, not a stable session ID (Anthropic's API doesn't send one). If
  Claude Code's HTTP client doesn't keep that connection alive across
  turns, routing state won't persist between turns — verify this in your
  own environment before relying on the sticky/break-even logic.
- Usage-token extraction scans the raw response bytes for `usage` objects
  rather than a full SSE event parser — pragmatic for v1, revisit if a
  real session shows missing usage data in the ledger.
- The upgrade-suggestion note is injected as conversation content for the
  model to relay, not a UI element — it depends on the model choosing to
  mention it.
- No multi-provider routing (see `claude-code-router` for that), no
  Bedrock/Vertex/Azure gateway support, no UI beyond the CLI report.

## License

MIT
```

- [ ] **Step 3: Commit**

```bash
git add README.md package.json
git commit -m "docs: add README covering setup, config, and known v1 limitations"
```

- [ ] **Step 4: Manual end-to-end validation (requires live `TYPESAFE_API_KEY` and Anthropic credentials — not part of the automated suite)**

Follow the design spec's testing plan exactly:

1. Run `npm start` (shadow mode, default) with `ANTHROPIC_BASE_URL` pointed at it from a real `claude` session. Do a mixed session: a few trivial asks, some real coding, one hard debugging question.
2. Tail `./router-ledger.jsonl`. Confirm judged tiers look sane and `cacheReadTokens`/`cacheCreationTokens` match the pattern this doc describes (mostly reads, occasional resets).
3. Confirm the connection-based conversation key persists across turns in one session — if `turnsOnCurrentTier` never advances past 1, Claude Code's client isn't keeping the connection alive, and `conversationKey.ts`'s socket-based keying needs the content-hash fallback noted in the spec's "Open risks."
4. Open two `claude` sessions concurrently in the same directory; confirm their ledger entries don't show one session's decisions bleeding into the other's `turnsOnCurrentTier`.
5. Run `npm run report -- ./router-ledger.jsonl` and sanity-check the numbers against what you observed.
6. Flip to `ROUTER_MODE=live npm start` for a short session. Confirm Claude Code's status line reflects a tier switch when one happens, confirm no `400` errors mentioning `cache_control` appear, and confirm the switch is visible in the ledger.

This step has no pass/fail assertion to check off mechanically — record what you find (especially step 3's outcome) as a follow-up issue in the repo if the connection-keepalive assumption doesn't hold.

---

## Self-Review Notes

- **Spec coverage:** every named section of the design spec (Problem/cache-tax math, four tiers, asymmetric downgrade/upgrade policy, reset detection, probability-margin comparison, connection-based conversation identity, shadow mode, cost ledger + report, upgrade-suggestion injection, passthrough requirements) has a corresponding task above.
- **Type consistency:** `Tier`, `ClassifyResult`, `ConversationState`, `Decision`, `PricingConfig`/`PricingRates`, and `LedgerLine` are defined once (Tasks 2 and 10) and imported by name everywhere else — checked against Tasks 6, 7, 8, 10, 11, 12 for drift.
- **Numeric consistency caught during this review:** a prefix-only break-even formula (cache read/write rates only) gives ~12.5 turns for Sonnet→Haiku, not the ~3.2 turns the spec's Problem section illustrates, because it drops the new/output token cost each turn also carries. Fixed by tracking `lastNewTokens`/`lastOutputTokens` in `ConversationState` (Task 2) and folding them into `switchTax`/`breakEvenTurns` (Task 5), with hand-verified numbers threading through Tasks 5–7 and 11 consistently. Both this plan and the spec were updated together so they agree.
- **No placeholders:** every step above has real, complete code — no TODOs or "similar to Task N" references.
