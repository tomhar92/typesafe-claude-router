import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTurn } from "../src/classify.js";

function fakeResponse(choiceValue: string) {
  return {
    answers: {
      tier: {
        type: "choice",
        choice: choiceValue,
        confidence: 0.8,
        probabilities: { haiku: 0.1, sonnet: 0.1, opus: 0.7, fable: 0.1 },
      },
    },
  };
}

test("maps a successful TypeSafe response to a ClassifyResult", async () => {
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "fix this hard bug" },
    { call: async () => fakeResponse("opus") }
  );
  assert.deepEqual(result, {
    choice: "opus",
    confidence: 0.8,
    probabilities: { haiku: 0.1, sonnet: 0.1, opus: 0.7, fable: 0.1 },
  });
});

test("returns null when the call rejects", async () => {
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "x" },
    { call: async () => { throw new Error("network error"); } }
  );
  assert.equal(result, null);
});

test("returns null when the call exceeds the timeout budget", async () => {
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "x" },
    {
      timeoutMs: 20,
      call: () => new Promise((resolve) => setTimeout(() => resolve(fakeResponse("haiku")), 500)),
    }
  );
  assert.equal(result, null);
});
