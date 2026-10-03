import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backendFromEnv,
  openRouterBackend,
  validateBackendConfig,
  type ClassifierRequest,
} from "../src/classifierBackend.js";
import { classifyTurn } from "../src/classify.js";

const REQUEST: ClassifierRequest = {
  state: { recentMessages: [{ role: "user", content: "hi" }], latestUserMessage: "hi" },
  instructions: "Which tier?",
  criteria: { haiku: "easy", sonnet: "normal", opus: "hard", fable: "extreme" },
};

const PROBABILITIES = { haiku: 0.1, sonnet: 0.2, opus: 0.6, fable: 0.1 };

function okResponse(answer: unknown): Response {
  return new Response(JSON.stringify({ model: "typesafe/jev-1.13", answers: { tier: answer }, usage: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function recordingFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("openrouter: posts the question in OpenRouter's wire format with bearer auth", async () => {
  const { calls, fetchImpl } = recordingFetch(() =>
    okResponse({ type: "choice", choice: "opus", confidence: 0.6, probabilities: PROBABILITIES })
  );
  const backend = openRouterBackend({ apiKey: "sk-or-1", model: "typesafe/jev-1.13", fetch: fetchImpl });

  const answer = await backend.choose(REQUEST, { timeoutMs: 1000 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/alpha/decisions");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer sk-or-1");
  assert.equal(headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    model: "typesafe/jev-1.13",
    state: REQUEST.state,
    questions: {
      tier: { type: "choice", instructions: "Which tier?", criteria: REQUEST.criteria },
    },
  });
  assert.deepEqual(answer, { choice: "opus", confidence: 0.6, probabilities: PROBABILITIES });
});

test("openrouter: honours a custom base URL without doubling slashes", async () => {
  const { calls, fetchImpl } = recordingFetch(() => okResponse({ type: "choice", choice: "opus" }));
  const backend = openRouterBackend({
    apiKey: "k",
    model: "m",
    baseURL: "http://localhost:9000/",
    fetch: fetchImpl,
  });
  await backend.choose(REQUEST, { timeoutMs: 1000 });
  assert.equal(calls[0].url, "http://localhost:9000/api/alpha/decisions");
});

test("openrouter: a non-2xx response is an error, not an answer", async () => {
  const { fetchImpl } = recordingFetch(
    () => new Response(JSON.stringify({ error: { code: 402, message: "no credits" } }), { status: 402 })
  );
  const backend = openRouterBackend({ apiKey: "k", model: "m", fetch: fetchImpl });
  await assert.rejects(backend.choose(REQUEST, { timeoutMs: 1000 }), /402/);
});

test("openrouter: a malformed answer is an error", async () => {
  const { fetchImpl } = recordingFetch(() => okResponse({ type: "noul", noul: 0.5 }));
  const backend = openRouterBackend({ apiKey: "k", model: "m", fetch: fetchImpl });
  await assert.rejects(backend.choose(REQUEST, { timeoutMs: 1000 }), /malformed/);
});

test("openrouter: aborts the HTTP request when the deadline passes", async () => {
  let aborted = false;
  const fetchImpl = ((_url: unknown, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    })) as typeof fetch;
  const backend = openRouterBackend({ apiKey: "k", model: "m", fetch: fetchImpl });
  await assert.rejects(backend.choose(REQUEST, { timeoutMs: 20 }));
  assert.equal(aborted, true);
});

test("openrouter: aborts the HTTP request when the caller's signal fires", async () => {
  const controller = new AbortController();
  let aborted = false;
  const fetchImpl = ((_url: unknown, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    })) as typeof fetch;
  const backend = openRouterBackend({ apiKey: "k", model: "m", fetch: fetchImpl });
  const pending = backend.choose(REQUEST, { timeoutMs: 10_000, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
  assert.equal(aborted, true);
});

test("classifyTurn over the openrouter backend maps a good answer", async () => {
  const { fetchImpl } = recordingFetch(() =>
    okResponse({ type: "choice", choice: "opus", confidence: 0.6, probabilities: PROBABILITIES })
  );
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "hard bug" },
    { backend: openRouterBackend({ apiKey: "k", model: "m", fetch: fetchImpl }) }
  );
  assert.deepEqual(result, { choice: "opus", confidence: 0.6, probabilities: PROBABILITIES });
});

test("classifyTurn rejects an unknown tier name from a backend", async () => {
  const { fetchImpl } = recordingFetch(() =>
    okResponse({ type: "choice", choice: "gpt-9", confidence: 0.9, probabilities: PROBABILITIES })
  );
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "x" },
    { backend: openRouterBackend({ apiKey: "k", model: "m", fetch: fetchImpl }) }
  );
  assert.equal(result, null);
});

test("classifyTurn treats a missing confidence as an unusable answer", async () => {
  const { fetchImpl } = recordingFetch(() =>
    okResponse({ type: "choice", choice: "opus", probabilities: PROBABILITIES })
  );
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "x" },
    { backend: openRouterBackend({ apiKey: "k", model: "m", fetch: fetchImpl }) }
  );
  assert.equal(result, null);
});

test("classifyTurn returns null when the backend errors", async () => {
  const { fetchImpl } = recordingFetch(() => new Response("{}", { status: 500 }));
  const result = await classifyTurn(
    { recentMessages: [], latestUserMessage: "x" },
    { backend: openRouterBackend({ apiKey: "k", model: "m", fetch: fetchImpl }) }
  );
  assert.equal(result, null);
});

test("backendFromEnv: defaults to the TypeSafe SDK", () => {
  assert.equal(typeof backendFromEnv({}).choose, "function");
});

test("backendFromEnv: openrouter without a key throws", () => {
  assert.throws(() => backendFromEnv({ ROUTER_CLASSIFIER: "openrouter" }), /OPENROUTER_API_KEY/);
});

test("backendFromEnv: an unknown classifier name throws", () => {
  assert.throws(() => backendFromEnv({ ROUTER_CLASSIFIER: "gpt" }), /ROUTER_CLASSIFIER/);
});

test("validateBackendConfig: quiet for defaults and a complete openrouter config", () => {
  assert.deepEqual(validateBackendConfig({}), []);
  assert.deepEqual(validateBackendConfig({ ROUTER_CLASSIFIER: "typesafe" }), []);
  assert.deepEqual(validateBackendConfig({ ROUTER_CLASSIFIER: "openrouter", OPENROUTER_API_KEY: "k" }), []);
});

test("validateBackendConfig: flags a missing openrouter key and an unknown backend", () => {
  assert.match(validateBackendConfig({ ROUTER_CLASSIFIER: "openrouter" })[0], /OPENROUTER_API_KEY/);
  assert.match(validateBackendConfig({ ROUTER_CLASSIFIER: "nope" })[0], /ROUTER_CLASSIFIER/);
});
