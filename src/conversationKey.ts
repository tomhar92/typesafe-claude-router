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
  state.currentTier = decisionTier;
  state.turnsOnCurrentTier += 1;
  state.lastPrefixTokens =
    (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  state.lastNewTokens = usage.input_tokens ?? 0;
  state.lastOutputTokens = usage.output_tokens ?? 0;
  state.lastMessageCount = currentMessages.length;
  state.lastMessages = currentMessages;
}
