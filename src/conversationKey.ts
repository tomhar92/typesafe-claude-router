import { createHash } from "node:crypto";
import type { ConversationState, Tier } from "./types.js";
import { stripCacheControl } from "./reset.js";

const store = new WeakMap<object, ConversationState>();

// Anthropic's API sends no session id, and Claude Code opens new TCP
// connections mid-conversation (and shares one between the main thread and
// subagents), so a socket is a poor identity: a fresh connection looked
// like a brand-new conversation, which is a reset, which let an upgrade
// through that the policy says is only ever a suggestion. A conversation
// is identified by its first message instead. It is stable for the life
// of a session, and `/clear`, `/compact` and every new subagent start
// with a different one. Bounded, oldest evicted first.
const MAX_CONVERSATIONS = 500;

function fingerprint(messages: unknown[]): string | null {
  if (messages.length === 0) return null;
  return createHash("sha256")
    .update(JSON.stringify(stripCacheControl(messages[0])))
    .digest("hex");
}

// Ledger lines need a conversationKey that actually distinguishes
// concurrent sessions - the previous hardcoded "socket" string logged the
// same literal for every connection, making it useless for telling
// interleaved sessions apart in the report. This is process-local and
// resets on restart, which is fine: it only needs to be unique among the
// connections a single running proxy instance is currently juggling.
let nextConnectionId = 0;

export interface ConversationStore {
  getOrInitState(socket: object, initialTier: Tier, messages?: unknown[]): ConversationState;
}

// One store per proxy instance, so two servers (or two tests) never share
// conversations just because their first messages happen to match.
export function createConversationStore(): ConversationStore {
  const byFingerprint = new Map<string, ConversationState>();
  return {
    getOrInitState(socket, initialTier, messages = []) {
      const key = fingerprint(messages);
      if (key !== null) {
        const known = byFingerprint.get(key);
        if (known) {
          // Re-insert so the Map's insertion order doubles as recency.
          byFingerprint.delete(key);
          byFingerprint.set(key, known);
          return known;
        }
      }
      let state = key === null ? store.get(socket) : undefined;
      if (!state) {
        nextConnectionId += 1;
        state = {
          connectionId: `${key === null ? "conn" : "conv"}-${nextConnectionId}`,
          currentTier: initialTier,
          turnsOnCurrentTier: 0,
          lastPrefixTokens: 0,
          lastNewTokens: 0,
          lastOutputTokens: 0,
          lastMessages: [],
          lastRequestedTier: initialTier,
        };
        if (key === null) {
          store.set(socket, state);
        } else {
          byFingerprint.set(key, state);
          if (byFingerprint.size > MAX_CONVERSATIONS) {
            byFingerprint.delete(byFingerprint.keys().next().value as string);
          }
        }
      }
      return state;
    },
  };
}

const defaultStore = createConversationStore();

export function getOrInitState(
  socket: object,
  initialTier: Tier,
  messages: unknown[] = []
): ConversationState {
  return defaultStore.getOrInitState(socket, initialTier, messages);
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
