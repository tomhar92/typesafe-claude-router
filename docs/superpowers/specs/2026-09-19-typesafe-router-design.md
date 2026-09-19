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

A consequence worth stating plainly: because the tax scales with prefix
size, and prefix size only grows over a session, **a profitable mid-session
switch will be rare** except at moments where the cache was going to be
rebuilt anyway (session start, `/clear`, `/compact` — see "Reset detection"
below). Most of a session's turns will see the router hold its current
tier. That's the correct behavior, not a bug — the router's job is to pick
well at the cheap moments and otherwise get out of the way, rather than to
chase a tier switch on every message.

## Goal

Build an open-source proxy that:
1. Uses TypeSafe (Jev, via the `Choice` primitive) to judge which of four
   tiers — `haiku`, `sonnet`, `opus`, `fable` (ascending cost/capability) —
   a turn actually needs.
2. Treats downgrades and upgrades asymmetrically:
   - **Downgrades** (cheaper tier) are a pure cost optimization with no
     quality risk, so they're fully automatic, gated only by the
     switch-tax math — it can decline to downgrade even when the
     classifier is confident, if switching isn't worth it yet.
   - **Upgrades** (pricier tier) trade money for capability, which is a
     judgment call about the task, not just arithmetic. Above a
     confidence threshold, the router surfaces the suggestion — with the
     estimated switch cost shown — instead of silently applying or
     silently ignoring it. See "Upgrade suggestions" below.
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
   `criteria` = `{ haiku, sonnet, opus, fable }`, each described by the
   kind of turn it fits (mechanical/lookup/trivial-edit → haiku; typical
   multi-file coding → sonnet; hard debugging/architecture/ambiguous →
   opus; the rare case that genuinely calls for the top tier → fable).
   Returns a chosen tier + confidence.
4. **Apply the policy** (pure code, described below) to decide whether to
   rewrite `model` (downgrades), inject an upgrade suggestion, or hold,
   given the classifier's answer and the conversation's tracked state.
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

### Policy

State tracked per conversation key: `currentTier`, `turnsOnCurrentTier`,
`lastPrefixTokens` (= `cache_read_input_tokens + cache_creation_input_tokens`
from the previous response, i.e. the best available estimate of the next
request's prefix size), `lastMessageCount` (length of the `messages` array
sent last turn, used for reset detection below).

Tier order for comparison purposes: `haiku < sonnet < opus < fable`.

Given a classifier result `(judgedTier, confidence)`:

1. If `judgedTier === currentTier`: no-op, increment `turnsOnCurrentTier`.
2. **Reset detection** (applies regardless of direction): if this
   request's `messages` array is shorter than `lastMessageCount`, or its
   first `lastMessageCount` entries don't match what was tracked last
   turn, the prefix was just invalidated by something else (`/clear`,
   `/compact`, a rewind, an MCP reconnect, first turn of the session —
   Claude Code's own docs list the full set of triggers). The cache-miss
   tax is already sunk for this turn independent of anything the router
   does, so `switchCost` is treated as ~0: apply the judged tier
   immediately (downgrade or upgrade) if `confidence >= CONFIDENCE_THRESHOLD`,
   no break-even math needed. Reset `turnsOnCurrentTier = 0`.
3. Otherwise, if `confidence < CONFIDENCE_THRESHOLD` (default 0.7,
   configurable): hold current tier, no suggestion.
4. Otherwise compute the switch-tax math:
   - `switchCost = lastPrefixTokens * writeRate[judgedTier]`
   - `perTurnDelta = lastPrefixTokens * (readRate[currentTier] - readRate[judgedTier])`
     (positive when `judgedTier` is cheaper to hold on than `currentTier`)
   - `breakEvenTurns = switchCost / perTurnDelta` when `perTurnDelta > 0`
5. **If `judgedTier` is a downgrade** (lower in tier order than
   `currentTier`, so `perTurnDelta > 0` by construction): switch
   automatically, no human involved, if `breakEvenTurns <= STICKY_ASSUMPTION`
   (default 3, configurable) — i.e. only when the router expects to
   recoup the one-time tax within a conservative number of turns. Else
   hold.
6. **If `judgedTier` is an upgrade** (higher in tier order, so
   `perTurnDelta < 0` — an upgrade never pays for itself in cache terms,
   it only ever costs more): never auto-switch. Instead, see "Upgrade
   suggestions" below.
7. On any TypeSafe error/timeout (default 2s budget): hold current tier,
   no suggestion, log the failure. The router must never block or fail a
   turn.

`readRate`/`writeRate` per tier and the tier→model-alias mapping
(respecting `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `_SONNET_` / `_OPUS_` /
`_FABLE_MODEL`) live in a single editable config file, since pricing
changes over time and this repo can't chase that automatically.

### Upgrade suggestions

When step 6 above fires outside a reset window (i.e. the classifier wants
a higher tier mid-session, where the switch is guaranteed to cost more
than it saves), the router doesn't decide for the user — it surfaces the
option and lets them decide, once confidence clears a separate
`UPGRADE_SUGGESTION_THRESHOLD` (default 0.75, configurable, can differ
from the downgrade threshold since the cost of a false positive here is
an ignorable suggestion rather than a silent quality or cost change).

Mechanism: append a short block to the outgoing request's `messages` array
(after the last message, so it doesn't touch anything behind the cache
breakpoint and costs only its own small size to send) worded as a system
note, e.g.: *"Router note: this turn looks like it may benefit from
`opus`-tier reasoning. Estimated one-time cost to switch now (cache
rebuild): $0.0X. Mention this to the user briefly if relevant; switching
is their call (`/model opus`)."* This mirrors how Claude Code itself
appends system-reminder content (e.g. file-change notices) without
disturbing the cached prefix. The model can then relay the suggestion in
its own reply when it judges that useful, rather than the router
fabricating text as if Claude said it.

This also gets logged to the ledger (`suggestedUpgradeTo`, `estimatedCost`)
regardless of whether the user acts on it, so the report can show how
often upgrades were suggested vs. actually taken (visible in the ledger
as a later real model switch on the same conversation key).

### Shadow mode

`ROUTER_MODE=shadow` (env var) runs steps 1–4 and logs the decision the
policy *would* have made (`wouldSwitchTo`, `actualTier`), but step 4 never
mutates `model` — the original request always goes through unchanged. This
lets someone validate classifier judgment and the cost model against a
real session with zero risk before trusting the router to actually act.
Default mode is `shadow`; a person opts into `ROUTER_MODE=live`.

### Cost ledger and report

Each ledger line: `{ ts, conversationKey, judgedTier, confidence, decision,
resetDetected, suggestedUpgradeTo, suggestedUpgradeCostUsd, actualModel,
inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
actualCostUsd, counterfactualNoRoutingCostUsd }`. `decision` is one of
`held` / `downgraded` / `upgraded-on-reset` / `upgrade-suggested`.

`counterfactualNoRoutingCostUsd` is computed from the same real token
counts as if the turn had run on whichever tier the conversation started
on (the first `model` this router ever saw for this conversation key),
with the cache state that turn actually had — this isolates "did routing
help on this turn" from "did this turn happen to be cheap or expensive
regardless," without assuming Sonnet was the baseline.

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
this doc: verify it holds and downgrades, verify it declines an
unprofitable downgrade, verify low confidence holds, verify TypeSafe
timeout holds, verify an upgrade never auto-switches outside a reset
window, verify reset detection applies a downgrade *and* an upgrade
immediately with no break-even check, verify reset detection correctly
triggers on a shortened `messages` array and doesn't false-trigger on a
normal append-only turn.

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
- Reset detection is a heuristic on `messages` array shape, not a direct
  signal from Claude Code. It should catch `/clear`, `/compact`, and
  session start reliably (all shorten or replace history), but a cache
  invalidation that only changes tool definitions or the system prompt
  (MCP connect/disconnect, plugin toggle, effort-level change) leaves the
  `messages` array itself untouched, so it won't be detected as a free
  window even though it also zeroes the switch tax. Worth revisiting if
  it turns out to matter in practice — likely by also comparing the
  system-prompt/tools hash against what was tracked last turn.
- The upgrade-suggestion note is injected as conversation content the
  model sees, not a UI element the user sees directly — it depends on the
  model choosing to relay it. If that proves unreliable in testing, a
  fallback is to also write it to the ledger and have `report` (or a
  live-tailing variant) surface it out-of-band.
