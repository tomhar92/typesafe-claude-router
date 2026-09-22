import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, Agent } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createProxyServer } from "../src/server.js";
import { readLedger } from "../src/ledger.js";
import { DEFAULT_PRICING } from "../src/pricing.js";

function listen(server: import("node:http").Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      if (typeof address === "object" && address) resolve(address.port);
    });
  });
}

// `fetch` doesn't guarantee socket reuse across sequential calls even with
// keep-alive, but a real `claude` process holds one persistent connection
// to the proxy for the session's duration (that's how conversation state
// is keyed - see conversationKey.ts). A single-socket keep-alive Agent
// reproduces that so multi-turn behavior can actually be tested.
function postOnSharedSocket(agent: Agent, port: number, body: unknown): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/messages",
        method: "POST",
        agent,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function withFakeUpstream(
  respond: (body: any) => { status: number; usage: Record<string, number>; text: string }
) {
  let lastBody: any = null;
  const fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const { status, usage, text } = respond(lastBody);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text }], usage }));
    });
  });
  const port = await listen(fake);
  return { url: `http://127.0.0.1:${port}`, close: () => fake.close(), getLastBody: () => lastBody };
}

test("holds tier, passes model through untouched, and logs real usage", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 20000 },
    text: "ok",
  }));

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    mode: "live",
    ledgerPath,
    classify: async () => ({
      choice: "sonnet",
      confidence: 0.8,
      probabilities: { haiku: 0.05, sonnet: 0.8, opus: 0.1, fable: 0.05 },
    }),
  });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(fake.getLastBody().model, DEFAULT_PRICING.modelAlias.sonnet);

  const lines = readLedger(ledgerPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].decision, "held");
  assert.equal(lines[0].inputTokens, 1000);
  assert.equal(lines[0].cacheReadTokens, 20000);

  router.close();
  fake.close();
});

test("rewrites the model field in live mode on a reset-window downgrade", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
    text: "ok",
  }));

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    mode: "live",
    ledgerPath,
    classify: async () => ({
      choice: "haiku",
      confidence: 0.9,
      probabilities: { haiku: 0.9, sonnet: 0.05, opus: 0.03, fable: 0.02 },
    }),
  });
  const port = await listen(router);

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      messages: [{ role: "user", content: "first turn on this connection" }],
    }),
  });

  assert.equal(fake.getLastBody().model, DEFAULT_PRICING.modelAlias.haiku);

  const lines = readLedger(ledgerPath);
  assert.equal(lines[0].decision, "downgraded-on-reset");

  router.close();
  fake.close();
});

test("shadow mode never rewrites the model even when the policy would switch", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
    text: "ok",
  }));

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    mode: "shadow",
    ledgerPath,
    classify: async () => ({
      choice: "haiku",
      confidence: 0.9,
      probabilities: { haiku: 0.9, sonnet: 0.05, opus: 0.03, fable: 0.02 },
    }),
  });
  const port = await listen(router);

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      messages: [{ role: "user", content: "first turn" }],
    }),
  });

  assert.equal(fake.getLastBody().model, DEFAULT_PRICING.modelAlias.sonnet);
  const lines = readLedger(ledgerPath);
  assert.equal(lines[0].decision, "downgraded-on-reset");

  router.close();
  fake.close();
});

test("a downgrade stays sticky on the next turn even though Claude Code keeps resending its own default model", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 0,
    },
    text: "ok",
  }));

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    mode: "live",
    ledgerPath,
    classify: async () => ({
      choice: "haiku",
      confidence: 0.9,
      probabilities: { haiku: 0.9, sonnet: 0.05, opus: 0.03, fable: 0.02 },
    }),
  });
  const port = await listen(router);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });

  const turn1Messages = [{ role: "user", content: "first turn on this connection" }];
  await postOnSharedSocket(agent, port, {
    model: DEFAULT_PRICING.modelAlias.sonnet,
    messages: turn1Messages,
  });
  assert.equal(fake.getLastBody().model, DEFAULT_PRICING.modelAlias.haiku);

  // Claude Code has no idea the router switched anything - it keeps
  // sending its own default (sonnet) every turn and just appends to the
  // same message array.
  const turn2Messages = [
    ...turn1Messages,
    { role: "assistant", content: "ok" },
    { role: "user", content: "second turn" },
  ];
  await postOnSharedSocket(agent, port, {
    model: DEFAULT_PRICING.modelAlias.sonnet,
    messages: turn2Messages,
  });
  assert.equal(
    fake.getLastBody().model,
    DEFAULT_PRICING.modelAlias.haiku,
    "held should stay on the router's tracked tier, not revert to the client's stale request"
  );

  const lines = readLedger(ledgerPath);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].decision, "downgraded-on-reset");
  assert.equal(lines[1].decision, "held");
  assert.equal(lines[1].actualTier, "haiku");

  agent.destroy();
  router.close();
  fake.close();
});

test("logs real usage from a realistic streamed response, including a nested cache_creation object", async () => {
  const fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Shaped like a real Anthropic stream: usage.cache_creation is a
      // nested object, and the final output_tokens only appears on the
      // trailing message_delta - a regex like `"usage":\s*(\{[^}]*\})`
      // truncates at the inner `}` and fails to parse.
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_1",
            usage: {
              input_tokens: 25,
              cache_creation_input_tokens: 3000,
              cache_read_input_tokens: 40000,
              cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 0 },
              output_tokens: 1,
            },
          },
        })}\n\n`
      );
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hi" },
        })}\n\n`
      );
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: { output_tokens: 842 },
        })}\n\n`
      );
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      res.end();
    });
  });
  const port0 = await listen(fake);

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: `http://127.0.0.1:${port0}`,
    mode: "shadow",
    ledgerPath,
    classify: async () => ({
      choice: "sonnet",
      confidence: 0.8,
      probabilities: { haiku: 0.05, sonnet: 0.8, opus: 0.1, fable: 0.05 },
    }),
  });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  await response.text();

  const lines = readLedger(ledgerPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].inputTokens, 25);
  assert.equal(lines[0].outputTokens, 842);
  assert.equal(lines[0].cacheCreationTokens, 3000);
  assert.equal(lines[0].cacheReadTokens, 40000);

  router.close();
  fake.close();
});

test("honors a manual model change instead of holding the router's previously tracked tier", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 0,
    },
    text: "ok",
  }));

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  let call = 0;
  const router = createProxyServer({
    upstream: fake.url,
    mode: "live",
    ledgerPath,
    classify: async () => {
      call += 1;
      return call === 1
        ? { choice: "haiku", confidence: 0.9, probabilities: { haiku: 0.9, sonnet: 0.05, opus: 0.03, fable: 0.02 } }
        : { choice: "opus", confidence: 0.85, probabilities: { haiku: 0.05, sonnet: 0.05, opus: 0.85, fable: 0.05 } };
    },
  });
  const port = await listen(router);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });

  const turn1Messages = [{ role: "user", content: "first turn on this connection" }];
  await postOnSharedSocket(agent, port, {
    model: DEFAULT_PRICING.modelAlias.sonnet,
    messages: turn1Messages,
  });
  assert.equal(fake.getLastBody().model, DEFAULT_PRICING.modelAlias.haiku);

  // The user runs `/model opus`; Claude Code now sends opus's alias.
  const turn2Messages = [
    ...turn1Messages,
    { role: "assistant", content: "ok" },
    { role: "user", content: "second turn" },
  ];
  await postOnSharedSocket(agent, port, {
    model: DEFAULT_PRICING.modelAlias.opus,
    messages: turn2Messages,
  });
  assert.equal(
    fake.getLastBody().model,
    DEFAULT_PRICING.modelAlias.opus,
    "a manual model switch should win over the router's previously tracked tier"
  );

  agent.destroy();
  router.close();
  fake.close();
});

test("responds 400 for a malformed request body instead of 502", async () => {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  // Upstream is unreachable on purpose: a malformed body must be rejected
  // before we ever try to forward anything.
  const router = createProxyServer({ upstream: "http://127.0.0.1:1", ledgerPath });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid json",
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "invalid_request_body");

  router.close();
});

test("strips stale content-encoding/content-length instead of forwarding them alongside already-decompressed bytes", async () => {
  // fetch (undici) transparently decompresses a gzip response body, but
  // response.headers still reports the *wire* content-encoding/length -
  // gzip and the compressed byte count. Forwarding those headers verbatim
  // while writing the already-decompressed bytes we actually read would
  // make the client try to gunzip plain text (or choke on a mismatched
  // length).
  const plaintext = JSON.stringify({
    type: "message",
    content: [{ type: "text", text: "ok" }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });
  const compressed = gzipSync(Buffer.from(plaintext, "utf8"));

  const fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(compressed.length),
      });
      res.end(compressed);
    });
  });
  const fakePort = await listen(fake);

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: `http://127.0.0.1:${fakePort}`,
    mode: "shadow",
    ledgerPath,
    classify: async () => null,
  });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      messages: [{ role: "user", content: "hi" }],
    }),
  });

  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("content-length"), null);
  const text = await response.text();
  assert.equal(
    text,
    plaintext,
    "the client should receive the real decompressed bytes, not bytes mislabeled as still-compressed"
  );

  router.close();
  fake.close();
});

test("destroys the connection instead of appending an error body when the upstream stream fails mid-response", async () => {
  const fake = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      // Give our proxy's read loop a chance to actually receive and
      // forward that first chunk (so *our* response has headers and a
      // body byte already sent) before the upstream connection drops -
      // destroying synchronously in the same tick can instead fail our
      // own outbound fetch() before it ever gets a response at all,
      // which exercises the "upstream never responded" path instead of
      // the "died mid-stream" one this test is about.
      setTimeout(() => res.destroy(), 50);
    });
  });
  const fakePort = await listen(fake);

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: `http://127.0.0.1:${fakePort}`,
    mode: "shadow",
    ledgerPath,
    classify: async () => null,
  });
  const port = await listen(router);

  let bodyReceived = "";
  let receivedError: Error | null = null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: DEFAULT_PRICING.modelAlias.sonnet,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    bodyReceived = await response.text();
  } catch (err) {
    receivedError = err as Error;
  }

  // Either the client sees the connection error while reading the body, or
  // it gets back exactly the partial bytes that were already sent - what
  // it must never see is the partial SSE bytes followed by a bolted-on
  // `{"error":"router_proxy_error"}` JSON blob, which would corrupt the
  // stream instead of signaling failure.
  assert.ok(
    receivedError !== null || !bodyReceived.includes("router_proxy_error"),
    "a corrupted mid-stream response must not have an error JSON body appended to it"
  );

  router.close();
  fake.close();
});

test("does not update routing state or write a ledger line for a non-2xx upstream response", async () => {
  const fake = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }));
    });
  });
  const fakePort = await listen(fake);

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: `http://127.0.0.1:${fakePort}`,
    mode: "live",
    ledgerPath,
    classify: async () => ({
      choice: "haiku",
      confidence: 0.9,
      probabilities: { haiku: 0.9, sonnet: 0.05, opus: 0.03, fable: 0.02 },
    }),
  });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(response.status, 429);
  await response.text();

  assert.deepEqual(readLedger(ledgerPath), []);

  router.close();
  fake.close();
});

test("logs a distinct classifier-unavailable decision instead of masquerading as a policy-driven hold", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    text: "ok",
  }));

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    mode: "live",
    ledgerPath,
    classify: async () => null, // simulates a TypeSafe timeout/error
  });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  await response.text();

  const lines = readLedger(ledgerPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].decision, "classifier-unavailable");
  assert.equal(lines[0].confidence, null);

  router.close();
  fake.close();
});

test("gates the upgrade-suggested note to live mode, so shadow mode never changes what the model actually sees", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    text: "ok",
  }));

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  let call = 0;
  const router = createProxyServer({
    upstream: fake.url,
    mode: "shadow",
    ledgerPath,
    classify: async () => {
      call += 1;
      // Turn 1 just establishes currentTier=sonnet via the reset branch
      // (argmax equals the already-current tier -> held, no margin check
      // involved). Turn 2 is a normal append, so the margin-based
      // "upgrade-suggested" path is the one actually under test.
      return call === 1
        ? { choice: "sonnet", confidence: 0.8, probabilities: { haiku: 0.05, sonnet: 0.8, opus: 0.1, fable: 0.05 } }
        : { choice: "opus", confidence: 0.7, probabilities: { haiku: 0.05, sonnet: 0.15, opus: 0.7, fable: 0.1 } };
    },
  });
  const port = await listen(router);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });

  const turn1Messages = [{ role: "user", content: "first turn on this connection" }];
  await postOnSharedSocket(agent, port, {
    model: DEFAULT_PRICING.modelAlias.sonnet,
    messages: turn1Messages,
  });

  const turn2Messages = [
    ...turn1Messages,
    { role: "assistant", content: "ok" },
    { role: "user", content: "a genuinely hard architecture question" },
  ];
  await postOnSharedSocket(agent, port, {
    model: DEFAULT_PRICING.modelAlias.sonnet,
    messages: turn2Messages,
  });

  const lines = readLedger(ledgerPath);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].decision, "upgrade-suggested");
  assert.deepEqual(
    fake.getLastBody().messages,
    turn2Messages,
    "shadow mode must not inject the upgrade note into what the model actually sees"
  );

  agent.destroy();
  router.close();
  fake.close();
});

test("counterfactual reclassifies a router-caused rebuild as a cache read, not a cache write, at the no-router tier", async () => {
  // Two turns on one connection: turn 1 establishes currentTier=opus via a
  // reset (classifier says opus), turn 2 is a genuine mid-session
  // "downgraded" (not reset) to haiku with a steep-enough margin. Only
  // *that* switch's cache-rebuild tokens are the router's own doing - in
  // a no-router world the session never leaves `requestedTier` (sonnet)
  // and this turn's prefix would still have been warm.
  const fake = await withFakeUpstream((body) => {
    const isTurn1 = body.messages.length === 1;
    return isTurn1
      ? {
          status: 200,
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            cache_creation_input_tokens: 20000,
            cache_read_input_tokens: 0,
          },
          text: "ok",
        }
      : {
          status: 200,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 3000,
            cache_read_input_tokens: 0,
          },
          text: "ok",
        };
  });

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  let call = 0;
  const router = createProxyServer({
    upstream: fake.url,
    mode: "live",
    ledgerPath,
    classify: async () => {
      call += 1;
      return call === 1
        ? { choice: "opus", confidence: 0.9, probabilities: { haiku: 0.03, sonnet: 0.03, opus: 0.9, fable: 0.04 } }
        : { choice: "haiku", confidence: 0.9, probabilities: { haiku: 0.9, sonnet: 0.03, opus: 0.03, fable: 0.04 } };
    },
  });
  const port = await listen(router);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });

  const turn1Messages = [{ role: "user", content: "first turn on this connection" }];
  await postOnSharedSocket(agent, port, {
    model: DEFAULT_PRICING.modelAlias.sonnet,
    messages: turn1Messages,
  });

  const turn2Messages = [
    ...turn1Messages,
    { role: "assistant", content: "ok" },
    { role: "user", content: "second turn" },
  ];
  await postOnSharedSocket(agent, port, {
    model: DEFAULT_PRICING.modelAlias.sonnet,
    messages: turn2Messages,
  });

  const lines = readLedger(ledgerPath);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].decision, "downgraded");

  // Actual: haiku's cache-*write* rate on the 3000 rebuild tokens.
  const expectedActual = (100 * 1 + 50 * 5 + 3000 * 1.25 + 0 * 0.1) / 1_000_000;
  // Counterfactual: sonnet's cache-*read* rate on those same 3000 tokens -
  // the buggy version would have used sonnet's cache-*write* rate instead
  // (0.0082 vs the correct 0.0013), overstating the no-routing baseline.
  const expectedCounterfactual = (100 * 2 + 50 * 10 + 0 * 2.5 + 3000 * 0.2) / 1_000_000;

  assert.ok(
    Math.abs(lines[1].actualCostUsd - expectedActual) < 1e-9,
    `expected actualCostUsd ~${expectedActual}, got ${lines[1].actualCostUsd}`
  );
  assert.ok(
    Math.abs(lines[1].counterfactualNoRoutingCostUsd - expectedCounterfactual) < 1e-9,
    `expected counterfactualNoRoutingCostUsd ~${expectedCounterfactual}, got ${lines[1].counterfactualNoRoutingCostUsd}`
  );

  agent.destroy();
  router.close();
  fake.close();
});
