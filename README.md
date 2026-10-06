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
- **Upgrades** (to a pricier tier) are applied at those same reset
  moments, when the classifier is confident enough. Mid-session they are
  never applied automatically: the router appends a note under the model's
  reply with the estimated cost and the `/model` command, and it's your
  call whether to act on it.
- Both are free to apply immediately at the moments the cache was going
  to be rebuilt anyway (session start, `/clear`, `/compact`).
- Every turn's *real* token usage and cost gets logged, so you can
  measure whether routing actually helped a given session instead of
  trusting a theoretical estimate.

Full design rationale: `docs/superpowers/specs/2026-09-19-typesafe-router-design.md`.

## What leaves your machine

Every turn, the last 6 messages of the conversation (including tool
results and file contents read into the session) are sent to the
classifier backend (TypeSafe's hosted API by default; see "Classifier
backends" below), in addition to the normal Anthropic API traffic.
The payload is bounded: image blocks are omitted, each string is truncated
at 2,000 characters, and the whole payload is capped at roughly 24,000
characters. The caps reduce the exposure, they do not eliminate it - if
that's not acceptable for a given session or codebase, don't point
`ANTHROPIC_BASE_URL` at this proxy for it.

All non-`/v1/messages` traffic (such as `/v1/messages/count_tokens` for
context accounting) is forwarded unmodified and unlogged to Anthropic.

## Classifier backends

The classifier talks to TypeSafe's `/v1/systemone` API through the
official SDK, which reads two environment variables, so any server that
implements the same wire format works without code changes:

```bash
TYPESAFE_BASE_URL=http://localhost:8000 \
TYPESAFE_DEFAULT_MODEL=<model name the server expects> \
typesafe-claude-router run -- claude
```

`TYPESAFE_API_KEY` is only required for TypeSafe's hosted API; the router
checks this at startup and prints which endpoint and model it is using.
Open and third-party decision models that advertise a TypeSafe-compatible
`/v1/systemone` endpoint (for example OpenJev, or models served by Ollaya)
are candidates, but **this repo has not tested any of them**.

Things to check before trusting a different backend:

- **Calibration.** The margin thresholds were chosen for Jev's probability
  distributions. A smaller model may be overconfident or flat. Run it
  with a tight `ROUTER_MIN_TIER`/`ROUTER_MAX_TIER` first and read the report.
- **All four tiers come back.** An answer missing any tier's probability
  is treated as no answer (logged as `classifier-unavailable`).
- **Where the payload goes.** The "What leaves your machine" caveats apply
  to hosted backends; a model on `localhost` keeps the payload on your
  machine.

Hosted services that use a different request format (for example
OpenRouter's `/api/alpha/decisions`) are not supported yet and would need
an adapter.

## Setup

Requires Node 20+ (the TypeSafe SDK requires it; the proxy itself uses the global `fetch`/`Headers` APIs).

```bash
export TYPESAFE_API_KEY=...      # from typesafe.ai
npx typesafe-claude-router run -- claude
```

`run` starts the proxy on an ephemeral loopback port, launches the command after `--` with `ANTHROPIC_BASE_URL` pointed at it,
and shuts the proxy down when the command exits. Your normal Anthropic
auth is passed through untouched. The router refuses to start without
`TYPESAFE_API_KEY` rather than quietly logging `classifier-unavailable`
on every turn.

The package is not published to npm yet. From a clone, run `npm install &&
npm run build && npm link`, which puts the same `typesafe-claude-router`
command on your PATH.

### Keeping the proxy running

If you want one long-lived proxy for several sessions, use two terminals:

```bash
typesafe-claude-router serve     # 127.0.0.1:8787 (PORT/HOST to change)
```

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
claude
```

From a clone without `npm link`, `npm start` is the same as `serve`.

### Reading the results

The router switches models for real: a switch decision rewrites the
`model` field of the request. Every turn is also logged, so watch
`./router-ledger.jsonl` fill in during a session, then run:

```bash
typesafe-claude-router report            # or: report path/to/ledger.jsonl
```

The path defaults to `ROUTER_LEDGER_PATH`, then `./router-ledger.jsonl`.
(From a clone: `npm run report`.)

### Before you rely on it

Routing is live from the first turn, so set a spend ceiling and check, from
a few real sessions, that:

- the report shows no (or very few) `classifier-unavailable` turns;
- there are no `unknown-model` turns, or you have added those models to
  `modelAlias` in `src/pricing.ts`;
- the answers from downgraded turns are as good as you need.

A cautious first run limits how far the router can move:

```bash
ROUTER_MIN_TIER=sonnet ROUTER_MAX_TIER=opus typesafe-claude-router run -- claude
```

The router warns at startup if there is no `ROUTER_MAX_TIER`.

## Configuration

| Env var | Purpose | Default |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | TypeSafe auth (required for the hosted API, optional for a self-hosted `TYPESAFE_BASE_URL`) | — |
| `TYPESAFE_BASE_URL` | Classifier API root; any `/v1/systemone`-compatible server | `https://api.typesafe.ai` |
| `TYPESAFE_DEFAULT_MODEL` | Classifier model name sent to that server | `jev-latest` |
| `ROUTER_LEDGER_PATH` | Where turn-by-turn cost data is logged | `./router-ledger.jsonl` |
| `PORT` | Local proxy port | `8787` |
| `HOST` | Interface the proxy binds to | `127.0.0.1` |
| `ROUTER_MARGIN_THRESHOLD` | Minimum probability margin before a downgrade/upgrade is even considered | `0.1` |
| `ROUTER_STICKY_ASSUMPTION` | Max break-even turns for an automatic downgrade to be worth it | `3` |
| `ROUTER_MIN_TIER` | Cheapest tier the router can switch to | `haiku` |
| `ROUTER_MAX_TIER` | Most expensive tier the router can switch to | `fable` |
| `ROUTER_RESET_CONFIDENCE_FLOOR` | Minimum classifier confidence needed to switch on a reset | `0.5` |
| `ROUTER_MAX_BODY_BYTES` | Hard cap on a buffered request body | `67108864` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `_SONNET_` / `_OPUS_` / `_FABLE_MODEL` | Which real model each tier maps to | see `src/pricing.ts` |

When first trying the router, set `ROUTER_MAX_TIER=opus` to limit routing to the cheaper tiers while you verify the router is working as expected.

`HOST` defaults to loopback-only: the proxy has no auth of its own (it
relies on whatever `ANTHROPIC_API_KEY` the client sends through), so
binding to all interfaces would let anyone on the network trigger paid
TypeSafe calls through your machine. Only widen it (e.g. `HOST=0.0.0.0`
in a container) if you understand that tradeoff. Additionally, requests
carrying `Origin` or a cross-site `Sec-Fetch-Site` are refused, because a
page in an already-open browser can otherwise reach loopback.

Pricing (`src/pricing.ts`) reflects research done 2026-09-19 and **will
drift** — check current Claude API pricing before trusting real spend
numbers from the report.

## Known limitations (v1)

- Conversation identity is a hash of the conversation's first message,
  not the TCP connection (Anthropic's API sends no session ID, and Claude
  Code opens new connections mid-conversation and shares one between the
  main thread and subagents). `/clear`, `/compact` and each subagent start
  with a different first message, so they count as new conversations. Two
  sessions that open with an identical first message would share routing
  state. State is held in memory (the 500 most recent conversations) and is
  lost on restart.
- Claude Code builds each request for the model it is using, so a request
  moved to Haiku is reshaped to match what Claude Code itself sends for
  Haiku (`src/adaptRequest.ts`: output cap, thinking mode, effort,
  `system`-role messages, beta flags). That is modelled on one captured
  Sonnet/Haiku pair and will drift as Claude Code changes; if routed
  Haiku turns start returning 400s, set `ROUTER_MIN_TIER=sonnet`.
- The upgrade-suggestion note is added to the reply as an extra text
  block, and only on a turn that ends normally (not when the model stops to
  call a tool; the next turn suggests again if it still applies). Claude
  Code keeps it in the conversation history like any other assistant text.
  The request itself is never modified for it, so it does not touch the cache.
- If TypeSafe errors or times out on a turn, the router holds the current
  tier and logs `decision: "classifier-unavailable"` (distinct from a
  genuine policy-driven `held`) so a broken API key doesn't quietly look
  like normal routing in the report.
- Non-2xx upstream responses (rate limits, auth failures, ...) are still
  forwarded to the client, but are not logged to the ledger or folded into
  routing state, since no real turn completed.
- No multi-provider routing (see `claude-code-router` for that), no
  Bedrock/Vertex/Azure gateway support, no UI beyond the CLI report.

## Development

```bash
npm test    # run the test suite (no network calls, no API keys needed)
npm run build   # compile to dist/
```

## License

MIT
