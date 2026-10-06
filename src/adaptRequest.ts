import type { Tier } from "./types.js";

// Claude Code builds each request for the model it is talking to. Observed
// by capturing a Sonnet 5.5 session and a Haiku 4.5 session side by side
// (2026-10-06), the Haiku request differs in these ways:
//   - max_tokens 32000, not 128000
//   - thinking {type: "enabled", budget_tokens} instead of {type: "adaptive"}
//   - no output_config (effort)
//   - no `system`-role messages: that text is folded into the user turn
//   - an anthropic-beta header without the flags below
// The router only swaps the `model` field, so when it moves a request onto
// a tier with a narrower surface it has to reshape the rest the same way,
// or Anthropic answers 400 ("role 'system' is not supported on this model").
// These are Claude Code implementation details and will drift; a tier with
// no entry is left untouched.
interface TierProfile {
  maxTokens: number;
  strippedBetas: readonly string[];
}

const PROFILES: Partial<Record<Tier, TierProfile>> = {
  haiku: {
    maxTokens: 32000,
    strippedBetas: [
      "mid-conversation-system-2026-04-07",
      "per-turn-control-2026-07-01",
      "mid-conversation-tool-changes-2026-07-01",
      "effort-2025-11-24",
      "afk-mode-2026-01-31",
      "dangerous-tool-use-2026-09-03",
      "thinking-display-updates-2026-08-18",
    ],
  },
};

type Block = { type?: unknown; text?: unknown };
type Message = { role?: unknown; content?: unknown };

function toBlocks(content: unknown): Block[] {
  if (Array.isArray(content)) return content as Block[];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

// A `system`-role message becomes text blocks on the user turn before it
// (or the one after it, if nothing precedes), wrapped as a system-reminder
// so the model still reads it as harness text rather than something the
// user typed. Deterministic, so the rewritten prefix is identical on every
// turn and still caches.
function foldSystemMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  let carried: Block[] = [];
  for (const message of messages) {
    if (message.role !== "system") {
      const content = carried.length > 0 && message.role === "user"
        ? [...carried, ...toBlocks(message.content)]
        : message.content;
      if (message.role === "user") carried = [];
      out.push(content === message.content ? message : { ...message, content });
      continue;
    }
    const reminder = toBlocks(message.content).map((block) =>
      block.type === "text" && typeof block.text === "string"
        ? { type: "text", text: `<system-reminder>\n${block.text}\n</system-reminder>` }
        : block
    );
    const previous = out[out.length - 1];
    if (previous?.role === "user") {
      out[out.length - 1] = { ...previous, content: [...toBlocks(previous.content), ...reminder] };
    } else {
      carried = [...carried, ...reminder];
    }
  }
  return out;
}

export function adaptBodyForTier(body: Record<string, unknown>, tier: Tier): void {
  const profile = PROFILES[tier];
  if (!profile) return;

  if (typeof body.max_tokens === "number" && body.max_tokens > profile.maxTokens) {
    body.max_tokens = profile.maxTokens;
  }

  delete body.output_config;
  delete body.safeguards;

  const thinking = body.thinking as { type?: unknown; budget_tokens?: unknown } | undefined;
  if (thinking && typeof body.max_tokens === "number") {
    const ceiling = body.max_tokens - 1;
    if (thinking.type === "adaptive") {
      body.thinking = { type: "enabled", budget_tokens: ceiling };
    } else if (typeof thinking.budget_tokens === "number" && thinking.budget_tokens > ceiling) {
      body.thinking = { ...thinking, budget_tokens: ceiling };
    }
  }

  if (Array.isArray(body.messages)) {
    body.messages = foldSystemMessages(body.messages as Message[]);
  }
}

// Returns the anthropic-beta header with the flags this tier rejects
// removed, or null if nothing is left (so the header can be dropped).
export function adaptBetaHeader(value: string, tier: Tier): string | null {
  const profile = PROFILES[tier];
  if (!profile) return value;
  const kept = value
    .split(",")
    .map((flag) => flag.trim())
    .filter((flag) => flag !== "" && !profile.strippedBetas.includes(flag));
  return kept.length > 0 ? kept.join(",") : null;
}
