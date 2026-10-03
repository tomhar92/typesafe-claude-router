import { choice, TypeSafeClient, type JsonValue } from "@typesafe-ai/sdk";
import { TIER_ORDER, type ClassifyResult, type Tier } from "./types.js";

let client: TypeSafeClient | undefined;

function getClient(): TypeSafeClient {
  if (!client) client = new TypeSafeClient();
  return client;
}

// `satisfies Record<Tier, string>` makes a missing or misspelled tier key
// a compile error; `as const` keeps the literal key types, so
// `answers.tier.choice` comes back as Tier and the old `as Tier` cast -
// which would have happily passed through any string the API returned -
// is gone.
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

export interface ClassifyInput {
  recentMessages: JsonValue[];
  latestUserMessage: string;
}

export interface ClassifyOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injection point for tests; defaults to the shared client. */
  client?: Pick<TypeSafeClient, "systemOne">;
}

function hasEveryTier(probabilities: Record<string, number>): boolean {
  return TIER_ORDER.every((tier) => Number.isFinite(probabilities[tier]));
}

export async function classifyTurn(
  input: ClassifyInput,
  options: ClassifyOptions = {}
): Promise<ClassifyResult | null> {
  const { timeoutMs = 2000, signal, client: injected } = options;
  try {
    const { answers } = await (injected ?? getClient()).systemOne(
      {
        state: {
          recentMessages: input.recentMessages,
          latestUserMessage: input.latestUserMessage,
        },
        questions: {
          tier: choice(
            "Which model tier does this turn actually need, given the recent conversation and the latest user message?",
            TIER_CRITERIA
          ),
        },
      },
      // The SDK owns the deadline. The hand-rolled wrapper this replaces
      // only rejected our own promise - it cancelled nothing, so the SDK
      // went on retrying (2 retries, 10s per attempt, with backoff) for
      // up to ~30s per turn, billed, with the answer thrown away. A
      // routing decision is useful for exactly one turn, so a retry that
      // lands after it is pure cost: no retries, one short deadline.
      { timeout: timeoutMs, retry: { maxRetries: 0 }, signal }
    );
    const answer = answers.tier;
    // A partial probability set would make every margin NaN, every
    // comparison false, and the router hold forever while the ledger
    // reported ordinary policy operation. Treat it as no answer at all,
    // which the server already logs distinctly.
    if (!hasEveryTier(answer.probabilities)) return null;
    return {
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: { ...answer.probabilities },
    };
  } catch {
    return null;
  }
}
