# TypeSafe Router for Claude Code — Design

Date: 2026-09-19

## Problem

Claude Code has no native way to route an individual turn to a cheaper or
more capable model based on what the turn is actually asking for. The only
supported interception point is a proxy: point `ANTHROPIC_BASE_URL` at a
local server that inspects each `/v1/messages` request before forwarding it
to Anthropic, and rewrites the `model` field.

Naively doing this loses money more often than it saves it. Anthropic's
prompt cache is scoped per model. Claude Code resends the full session
context (system prompt, tools, history) on every turn; on a cache hit that
context is billed at ~10% of the input rate, so most of a turn's cost is
already cheap. Switching models discards that cache: the very next request
on the new model reprocesses the entire prefix at the **cache-write** rate
(1.25x input), not the cache-read rate. Illustrative numbers (Sonnet 5
$2/$10 per Mtok, Haiku 4.5 $1/$5 per Mtok, ~20k cached context tokens, ~1k
new tokens, ~500 output tokens):

| Scenario | Cost/turn |
| --- | --- |
| Stay on Sonnet, cache hit (steady state) | ~$0.011 |
| Switch to Haiku for one turn (cache miss) | ~$0.029 |
| Stay on Haiku, cache hit (steady state) | ~$0.0055 |

Switching costs more than staying put unless the router then stays on the
cheaper tier for enough subsequent turns to amortize the one-time
cache-miss tax (roughly 3+ turns in this example). A router that flips
tiers on every message will typically make sessions more expensive, not
less, despite Haiku's lower nominal per-token price.

TypeSafe's Jev classification calls are cheap enough (~$0.042/Mtok input,
output free, ~$0.0004/typical call) to not be a factor in this math — the
cache-tax dominates, not the classifier cost.

## Goal

Build an open-source proxy that:
1. Uses TypeSafe (Jev, via the `Choice` primitive) to judge which model
   tier a turn actually needs.
2. Only acts on that judgment when the projected savings clear the
   cache-miss tax of switching — i.e. it can decline to switch even when
   the classifier is confident, if switching isn't worth it yet.
3. Measures itself: logs real `usage` data from actual API responses so a
   session's real cost-with-routing can be compared against the real
   cost-if-it-had-never-routed, instead of relying on theoretical numbers.

Non-goals for v1: multi-provider routing (already solved well by
`claude-code-router`), Bedrock/Vertex/Azure gateway support, any UI beyond
a CLI report, persistence beyond a local JSONL log.

## Architecture

```
Claude Code  --ANTHROPIC_BASE_URL-->  router proxy  --model rewritten-->  api.anthropic.com
                                            |
                                            +--> TypeSafe Jev (Choice)
                                            |
                                            +--> JSONL cost ledger
```

Single Node/TypeScript process, no framework dependency beyond the
standard `http`/`fetch` APIs and the TypeSafe JS SDK.

### Request path

For every incoming `POST /v1/messages` (streaming or not):

1. **Passthrough first.** Clone headers and body verbatim. The only field
   ever mutated is `model`. `cache_control` blocks, the `anthropic-beta`
   header (carries 1h-TTL opt-in and other betas), and everything else
   pass through unchanged — Claude Code's own docs warn that a gateway
   which drops or rejects `cache_control` silently bills every turn as
   fully uncached, which would corrupt the entire cost model this tool
   exists to protect.
2. **Extract routing state.** Latest user message content, plus the last
   ~3 turns for context, keyed by a conversation id (see below).
3. **Classify.** Call TypeSafe Jev `Choice` with `state` = that window and
   `criteria` = `{ haiku, sonnet, opus }`, each described by the kind of
   turn it fits (mechanical/lookup/trivial-edit → haiku; typical
   multi-file coding → sonnet; hard debugging/architecture/ambiguous →
   opus). Returns a chosen tier + confidence.
4. **Apply switch-tax policy** (pure code, described below) to decide
   whether to actually rewrite `model`, given the classifier's answer and
   the conversation's tracked state.
5. **Forward**, stream the response back untouched.
6. **Log.** After the response completes, read the real `usage` object
   (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
   `cache_read_input_tokens`) and the model actually used, compute actual
   cost from the configured pricing table, and append one JSON line to
   the ledger. This also updates the tracked prefix-size estimate used by
   the switch-tax policy on the next turn.

### Conversation identity

Claude Code doesn't send a stable session id to the API. The router keys
in-memory state by a hash of the request's system-prompt block content
(stable for a session; changes on `/clear`, `/compact`, or restart, which
is exactly when stale routing state should be discarded anyway).

### Switch-tax policy

State tracked per conversation key: `currentTier`, `turnsOnCurrentTier`,
`lastPrefixTokens` (= `cache_read_input_tokens + cache_creation_input_tokens`
from the previous response, i.e. the best available estimate of the next
request's prefix size).

Given a classifier result `(judgedTier, confidence)`:

- If `judgedTier === currentTier`: no-op, increment `turnsOnCurrentTier`.
- If `confidence < CONFIDENCE_THRESHOLD` (default 0.7, configurable):
  hold current tier.
- Else compute:
  - `switchCost = lastPrefixTokens * writeRate[judgedTier]`
  - `perTurnSavings = lastPrefixTokens * (readRate[currentTier] - readRate[judgedTier])`
  - `breakEvenTurns = switchCost / perTurnSavings` (skip/hold if
    `perTurnSavings <= 0`, i.e. judged tier isn't actually cheaper)
  - Switch only if `breakEvenTurns <= STICKY_ASSUMPTION` (default 3,
    configurable) — i.e. only when the router expects to recoup the
    one-time tax within a conservative number of turns.
- On switch: reset `turnsOnCurrentTier = 0`, update `currentTier`.
- On any TypeSafe error/timeout (default 2s budget): hold current tier,
  log the failure. The router must never block or fail a turn.

`readRate`/`writeRate` per tier and the tier→model-alias mapping
(respecting `ANTHROPIC_DEFAULT_HAIKU_MODEL` etc.) live in a single editable
config file, since pricing changes over time and this repo can't chase
that automatically.

### Shadow mode

`ROUTER_MODE=shadow` (env var) runs steps 1–4 and logs the decision the
policy *would* have made (`wouldSwitchTo`, `actualTier`), but step 4 never
mutates `model` — the original request always goes through unchanged. This
lets someone validate classifier judgment and the cost model against a
real session with zero risk before trusting the router to actually act.
Default mode is `shadow`; a person opts into `ROUTER_MODE=live`.

### Cost ledger and report

Each ledger line: `{ ts, conversationKey, judgedTier, confidence, decision,
actualModel, inputTokens, outputTokens, cacheCreationTokens,
cacheReadTokens, actualCostUsd, counterfactualSonnetCostUsd }`.

`counterfactualSonnetCostUsd` is computed from the same real token counts
as if the turn had run on Sonnet with the cache state it actually had —
this isolates "did routing help on this turn" from "did this turn happen
to be cheap or expensive regardless."

CLI: `npx typesafe-claude-router report [path-to-ledger]` prints total
actual cost, total counterfactual cost, delta, number of turns routed vs.
held, and TypeSafe spend — the real answer to "did this save money,"
computed from an actual session rather than the illustrative numbers
above.

## File layout

```
typesafe-claude-router/
  src/
    server.ts          # HTTP server, passthrough + streaming
    classify.ts         # TypeSafe Jev call
    policy.ts            # switch-tax decision logic (pure functions, unit-testable)
    pricing.ts           # tier -> model alias, tier -> rates, editable table
    ledger.ts             # JSONL append + read
    conversationKey.ts     # hash system-prompt block -> key
  bin/
    report.ts            # CLI entry for `report`
  test/
    policy.test.ts       # switch-tax math, no network
  README.md
  LICENSE (MIT)
  package.json
  tsconfig.json
```

## Testing plan

No mocking of the cache economics: `policy.ts` is pure functions over
numbers, tested directly with unit tests covering the numeric example in
this doc (verify it holds and switches, verify it declines an
unprofitable switch, verify low confidence holds, verify TypeSafe
timeout holds).

End-to-end validation uses live keys, per the earlier decision:
1. Run the proxy in `shadow` mode, point a real Claude Code session at it
   via `ANTHROPIC_BASE_URL`, do a mixed session (some trivial asks, some
   real coding, one hard debugging question).
2. Inspect the ledger: do judged tiers look sane, do the real
   `cache_read`/`cache_creation` numbers match the model in this doc.
3. Run `report` and sanity-check the counterfactual math.
4. Flip to `live` mode for a short session, confirm Claude Code's own
   status line reflects the model the router chose, confirm no `400`
   errors related to `cache_control`, confirm a mid-session switch is
   visible in the ledger.

## Open risks

- Conversation-key hashing on the system-prompt block is a heuristic;
  if Claude Code changes exactly what's cache-scoped, this needs
  revisiting (see the "How Claude Code uses prompt caching" doc's layer
  table).
- Pricing table will drift from reality over time; the report output
  should print the pricing table's date/source so stale numbers are
  visible rather than silently wrong.
- TypeSafe judging quality on the tier boundaries is unverified until
  tested against a real session — shadow mode exists specifically to
  surface this before it costs anything.
