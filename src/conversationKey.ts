import type { ConversationState, Tier } from "./types.js";

const store = new WeakMap<object, ConversationState>();

// Ledger lines need a conversationKey that actually distinguishes
// concurrent sessions - the previous hardcoded "socket" string logged the
// same literal for every connection, making it useless for telling
// interleaved sessions apart in the report. This is process-local and
// resets on restart, which is fine: it only needs to be unique among the
// connections a single running proxy instance is currently juggling.
let nextConnectionId = 0;

export function getOrInitState(socket: object, initialTier: Tier): ConversationState {
  let state = store.get(socket);
  if (!state) {
    nextConnectionId += 1;
    state = {
      connectionId: `conn-${nextConnectionId}`,
      currentTier: initialTier,
      turnsOnCurrentTier: 0,
      lastPrefixTokens: 0,
      lastNewTokens: 0,
      lastOutputTokens: 0,
      lastMessages: [],
      lastRequestedTier: initialTier,
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
  state.turnsOnCurrentTier = decisionTier === state.currentTier ? state.turnsOnCurrentTier + 1 : 1;
  state.currentTier = decisionTier;
  state.lastPrefixTokens =
    (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  state.lastNewTokens = usage.input_tokens ?? 0;
  state.lastOutputTokens = usage.output_tokens ?? 0;
  state.lastMessages = currentMessages;
}
