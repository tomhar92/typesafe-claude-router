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

## Development

```bash
npm test    # run the test suite (no network calls, no API keys needed)
npm run build   # compile to dist/
```

## License

MIT
