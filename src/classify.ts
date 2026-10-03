import type { JsonValue } from "@typesafe-ai/sdk";
import { backendFromEnv, type ClassifierBackend } from "./classifierBackend.js";
import { TIER_ORDER, type ClassifyResult, type Tier } from "./types.js";

// `satisfies Record<Tier, string>` makes a missing or misspelled tier key
// a compile error.
const TIER_CRITERIA = {
  haiku:
    "Mechanical or trivial: reading a file, running a known command, a simple factual question, a small well-specified edit.",
  sonnet:
    "Typical software engineering task: multi-file changes, moderate reasoning, normal debugging.",
  opus:
    "Hard reasoning: ambiguous requirements, tricky debugging, architectural decisions, multi-step planning.",
  fable:
    "Exceptionally demanding: the task explicitly calls for the deepest available reasoning or highest-stakes correctness.",
} as const satisfies Record<Tier, string>;

const TIER_QUESTION =
  "Which model tier does this turn actually need, given the recent conversation and the latest user message?";

export interface ClassifyInput {
  recentMessages: JsonValue[];
  latestUserMessage: string;
}

export interface ClassifyOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Overrides the backend chosen by ROUTER_CLASSIFIER; used by tests. */
  backend?: ClassifierBackend;
}

let defaultBackend: ClassifierBackend | undefined;

function isTier(value: string): value is Tier {
  return (TIER_ORDER as readonly string[]).includes(value);
}

function hasEveryTier(probabilities: Record<string, number> | undefined): probabilities is Record<Tier, number> {
  return (
    probabilities !== undefined && TIER_ORDER.every((tier) => Number.isFinite(probabilities[tier]))
  );
}

export async function classifyTurn(
  input: ClassifyInput,
  options: ClassifyOptions = {}
): Promise<ClassifyResult | null> {
  const { timeoutMs = 2000, signal } = options;
  try {
    // Built inside the try on purpose: a misconfigured backend must
    // degrade to "classifier unavailable" like any other transport failure.
    const backend = options.backend ?? (defaultBackend ??= backendFromEnv(process.env));
    const answer = await backend.choose(
      {
        state: {
          recentMessages: input.recentMessages,
          latestUserMessage: input.latestUserMessage,
        },
        instructions: TIER_QUESTION,
        criteria: TIER_CRITERIA,
      },
      { timeoutMs, signal }
    );
    // Backends are untrusted translators. A tier name we do not know, or a
    // missing confidence, would flow straight into the policy. A partial
    // probability set would make every margin NaN, every comparison
    // false, and the router hold forever while the ledger reported
    // ordinary policy operation. All of these count as no answer, which
    // the server already logs distinctly.
    if (!isTier(answer.choice)) return null;
    const { probabilities, confidence } = answer;
    if (!hasEveryTier(probabilities)) return null;
    if (confidence === undefined || !Number.isFinite(confidence)) return null;
    return {
      choice: answer.choice,
      confidence,
      probabilities: {
        haiku: probabilities.haiku,
        sonnet: probabilities.sonnet,
        opus: probabilities.opus,
        fable: probabilities.fable,
      },
    };
  } catch {
    return null;
  }
}
