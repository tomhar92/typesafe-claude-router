import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type { ClassifyResult, Tier } from "./types.js";

let client: TypeSafeClient | undefined;

function getClient(): TypeSafeClient {
  if (!client) client = new TypeSafeClient();
  return client;
}

const TIER_CRITERIA = {
  haiku:
    "Mechanical or trivial: reading a file, running a known command, a simple factual question, a small well-specified edit.",
  sonnet:
    "Typical software engineering task: multi-file changes, moderate reasoning, normal debugging.",
  opus:
    "Hard reasoning: ambiguous requirements, tricky debugging, architectural decisions, multi-step planning.",
  fable:
    "Exceptionally demanding: the task explicitly calls for the deepest available reasoning or highest-stakes correctness.",
};

export interface ClassifyInput {
  recentMessages: unknown[];
  latestUserMessage: string;
}

type SystemOneCall = (args: unknown) => Promise<any>;

function defaultCall(args: unknown): Promise<any> {
  return getClient().systemOne(args as never);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("typesafe_timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export async function classifyTurn(
  input: ClassifyInput,
  options: { timeoutMs?: number; call?: SystemOneCall } = {}
): Promise<ClassifyResult | null> {
  const { timeoutMs = 2000, call = defaultCall } = options;
  try {
    const response = await withTimeout(
      call({
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
      }),
      timeoutMs
    );
    const answer = response.answers.tier;
    return {
      choice: answer.choice as Tier,
      confidence: answer.confidence,
      probabilities: answer.probabilities as Record<Tier, number>,
    };
  } catch {
    return null;
  }
}
