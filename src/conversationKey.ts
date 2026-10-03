import { createHash } from "node:crypto";
import { stringifyWithoutCacheControl } from "./normalize.js";
import type { ConversationState, Tier } from "./types.js";

// Socket identity is not conversation identity. Connection pools rotate,
// Claude Code issues background small-model calls over the same pooled
// socket, and two concurrent sessions can share one - each of which
// resets turnsOnCurrentTier and trips detectReset against a history
// belonging to something else. The system prompt plus the first message
// is stable for the life of a session, distinguishes concurrent
// sessions, and hands background calls their own state for free.
//
// A /compact rewrites the history, so it produces a new key. That is the
// behaviour we want: the cache is being rebuilt regardless, and the new
// state's empty history makes the next turn a reset window - which is
// exactly what a compact is.
export function conversationKeyFor(body: { system?: unknown; messages?: unknown }): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const seed = stringifyWithoutCacheControl([body.system ?? null, messages[0] ?? null]);
  return `conv-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

// The WeakMap this replaces was collected with its socket. A string-keyed
// Map is not, so state has to be aged out explicitly or a long-lived
// proxy accumulates one entry per session it has ever seen.
const MAX_IDLE_MS = 6 * 60 * 60 * 1000;
const states = new Map<string, { state: ConversationState; lastSeen: number }>();

export function getOrInitState(
  key: string,
  initialTier: Tier,
  now: number = Date.now()
): ConversationState {
  for (const [existing, entry] of states) {
    if (now - entry.lastSeen > MAX_IDLE_MS) states.delete(existing);
  }
  const found = states.get(key);
  if (found) {
    found.lastSeen = now;
    return found.state;
  }
  const state: ConversationState = {
    conversationId: key,
    currentTier: initialTier,
    turnsOnCurrentTier: 0,
    lastPrefixTokens: 0,
    lastNewTokens: 0,
    lastOutputTokens: 0,
    lastMessages: [],
    lastRequestedTier: initialTier,
  };
  states.set(key, { state, lastSeen: now });
  return state;
}

/** Drops every tracked conversation. State is process-global and keyed by
 * content, so tests that reuse the same first message would otherwise
 * inherit each other's routing history; socket keying used to isolate them
 * by accident. */
export function resetConversationStates(): void {
  states.clear();
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
  state.turnsOnCurrentTier = decisionTier === state.currentTier ? state.turnsOnCurrentTier + 1 : 1;
  state.currentTier = decisionTier;
  state.lastPrefixTokens =
    (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  state.lastNewTokens = usage.input_tokens ?? 0;
  state.lastOutputTokens = usage.output_tokens ?? 0;
  state.lastMessages = currentMessages;
}
