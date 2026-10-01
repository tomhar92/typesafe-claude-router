import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTurn } from "../src/classify.js";

const PROBABILITIES = { haiku: 0.1, sonnet: 0.1, opus: 0.7, fable: 0.1 };

function fakeResponse(choiceValue: string, probabilities: Record<string, number> = PROBABILITIES) {
  return {
    answers: {
      tier: { type: "choice", choice: choiceValue, confidence: 0.8, probabilities },
    },
  };
}

function clientReturning(response: unknown, onCall?: (request: unknown, options: unknown) => void) {
  return {
    systemOne: (async (request: unknown, options: unknown) => {
      onCall?.(request, options);
      return response;
    }) as never,
  };
}

test("maps a successful TypeSafe response to a ClassifyResult", async () => {
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "fix this hard bug" },
    { client: clientReturning(fakeResponse("opus")) }
  );
  assert.deepEqual(result, { choice: "opus", confidence: 0.8, probabilities: PROBABILITIES });
});

test("returns null when the call rejects", async () => {
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "x" },
    {
      client: {
        systemOne: (async () => {
          throw new Error("network error");
        }) as never,
      },
    }
  );
  assert.equal(result, null);
});

test("gives the SDK the deadline and disables its retries", async () => {
  let seen: any = null;
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "hi" },
    {
      timeoutMs: 1500,
      client: clientReturning(fakeResponse("sonnet"), (_request, options) => {
        seen = options;
      }),
    }
  );
  assert.equal(seen.timeout, 1500);
  assert.equal(seen.retry.maxRetries, 0);
  assert.equal(result?.choice, "sonnet");
});

test("forwards the caller's abort signal to the SDK", async () => {
  const controller = new AbortController();
  let seen: any = null;
  await classifyTurn(
    { recentMessages: [], latestUserMessage: "hi" },
    {
      signal: controller.signal,
      client: clientReturning(fakeResponse("sonnet"), (_request, options) => {
        seen = options;
      }),
    }
  );
  assert.equal(seen.signal, controller.signal);
});

test("treats a partial probability set as an unusable answer", async () => {
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "hi" },
    { client: clientReturning(fakeResponse("sonnet", { sonnet: 0.8 })) }
  );
  assert.equal(result, null);
});
