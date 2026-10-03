import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, Agent } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createProxyServer } from "../src/server.js";
import { resetConversationStates } from "../src/conversationKey.js";
import { readLedger } from "../src/ledger.js";
import { DEFAULT_PRICING } from "../src/pricing.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ledgerMarginsFixture = fileURLToPath(
  new URL("./fixtures/server-ledger-margins.ts", import.meta.url)
);

function listen(server: import("node:http").Server): Promise<number> {
  // Routing state is keyed by conversation content, not by socket, so
  // tests that reuse a first message must not inherit each other's state.
  resetConversationStates();
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      if (typeof address === "object" && address) resolve(address.port);
    });
  });
}

// A single-socket keep-alive Agent reproduces a real `claude` process
// holding one persistent connection, so the keep-alive path gets exercised.
// Conversation state is no longer keyed on the socket (see
// conversationKey.ts), so this is not needed for state continuity.
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

test("live mode leaves an exact model pin alone when the decision is held", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    text: "ok",
  }));
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    mode: "live",
    ledgerPath,
    classify: async () => ({
      choice: "opus",
      confidence: 0.8,
      probabilities: { haiku: 0.05, sonnet: 0.1, opus: 0.8, fable: 0.05 },
    }),
  });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-5-20260101",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  await response.text();

  assert.equal(fake.getLastBody().model, "claude-opus-5-20260101");
  assert.equal(readLedger(ledgerPath)[0].decision, "held");

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

test("routing state follows the conversation across separate connections", async () => {
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
    mode: "shadow",
    ledgerPath,
    classify: async () => ({
      choice: "sonnet",
      confidence: 0.9,
      probabilities: { haiku: 0.05, sonnet: 0.9, opus: 0.03, fable: 0.02 },
    }),
  });
  const port = await listen(router);

  const first = [{ role: "user", content: "start the task" }];
  const second = [...first, { role: "assistant", content: "ok" }, { role: "user", content: "next" }];
  // A brand-new, non-keep-alive Agent per request guarantees each turn
  // arrives on its own TCP connection - the case socket keying lost.
  for (const messages of [first, second]) {
    const agent = new Agent({ keepAlive: false });
    await postOnSharedSocket(agent, port, {
      model: DEFAULT_PRICING.modelAlias.sonnet,
      system: "You are Claude Code.",
      messages,
    });
    agent.destroy();
  }

  const lines = readLedger(ledgerPath);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].turnsOnCurrentTier, 2);
  assert.equal(lines[0].conversationKey, lines[1].conversationKey);
  assert.equal(lines[1].resetDetected, false);

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

test("forwards an unrecognized model untouched and never calls the classifier", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    text: "ok",
  }));
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  let classifyCalls = 0;
  const router = createProxyServer({
    upstream: fake.url,
    mode: "live",
    ledgerPath,
    classify: async () => {
      classifyCalls += 1;
      return { choice: "haiku", confidence: 0.9, probabilities: { haiku: 0.9, sonnet: 0.05, opus: 0.03, fable: 0.02 } };
    },
  });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
  });
  await response.text();

  assert.equal(fake.getLastBody().model, "gpt-4o");
  assert.equal(classifyCalls, 0);
  const lines = readLedger(ledgerPath);
  assert.equal(lines[0].decision, "unknown-model");
  assert.equal(lines[0].actualTier, null);
  assert.equal(lines[0].actualCostUsd, null);

  router.close();
  fake.close();
});

test("a missing model field routes through the unknown-model path with a safe actualModel", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    text: "ok",
  }));
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  let classifyCalls = 0;
  const router = createProxyServer({
    upstream: fake.url,
    mode: "live",
    ledgerPath,
    classify: async () => {
      classifyCalls += 1;
      return { choice: "haiku", confidence: 0.9, probabilities: { haiku: 0.9, sonnet: 0.05, opus: 0.03, fable: 0.02 } };
    },
  });
  const port = await listen(router);

  // No `model` field at all - JSON.parse leaves body.model as `undefined`,
  // which is not a string, so tierForModel must treat it as unresolved
  // rather than the actualModel field silently disappearing from the
  // persisted JSONL (JSON.stringify drops undefined-valued properties).
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  await response.text();

  assert.equal(classifyCalls, 0);
  const lines = readLedger(ledgerPath);
  assert.equal(lines[0].decision, "unknown-model");
  assert.equal(lines[0].actualTier, null);
  assert.equal(lines[0].actualModel, "");

  router.close();
  fake.close();
});

test("an unknown-model turn does not make the next resolvable-model turn look like a reset", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    text: "ok",
  }));
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    mode: "live",
    ledgerPath,
    // A strong opus signal: if turn 2 is (wrongly) treated as a reset, decide()
    // takes the reset branch and immediately returns "upgraded-on-reset" for
    // any choice !== state.currentTier. If turn 2 is correctly recognized as a
    // continuation, decide() instead runs the margin path, which never
    // auto-switches upward - it can only produce "upgrade-suggested" or "held".
    classify: async () => ({
      choice: "opus",
      confidence: 0.95,
      probabilities: { haiku: 0.01, sonnet: 0.04, opus: 0.95, fable: 0.0 },
    }),
  });
  const port = await listen(router);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });

  // Turn 1 on this connection uses a model with no resolvable tier - it
  // must be forwarded untouched, but the conversation still grew.
  const turn1Messages = [{ role: "user", content: "first turn on this connection" }];
  await postOnSharedSocket(agent, port, { model: "gpt-4o", messages: turn1Messages });

  // Turn 2 uses a real, resolvable model and simply continues the same
  // conversation (a real superset of turn 1's messages) - this must not be
  // mistaken for a `/clear`/`/compact` reset just because turn 1 took the
  // unknown-model path.
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
  assert.equal(lines[0].decision, "unknown-model");
  assert.notEqual(
    lines[1].decision,
    "upgraded-on-reset",
    "turn 2 continues turn 1's conversation and must not be treated as a reset"
  );
  assert.equal(lines[1].resetDetected, false);

  agent.destroy();
  router.close();
  fake.close();
});

test("a dated opus model is priced as opus, not as the sonnet fallback", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 20000 },
    text: "ok",
  }));
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    mode: "shadow",
    ledgerPath,
    classify: async () => ({
      choice: "opus",
      confidence: 0.8,
      probabilities: { haiku: 0.05, sonnet: 0.1, opus: 0.8, fable: 0.05 },
    }),
  });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-5-20260101",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  await response.text();

  const lines = readLedger(ledgerPath);
  assert.equal(lines[0].actualTier, "opus");
  assert.equal(lines[0].actualModel, "claude-opus-5-20260101");

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
    Math.abs(lines[1].actualCostUsd! - expectedActual) < 1e-9,
    `expected actualCostUsd ~${expectedActual}, got ${lines[1].actualCostUsd}`
  );
  assert.ok(
    Math.abs(lines[1].counterfactualNoRoutingCostUsd! - expectedCounterfactual) < 1e-9,
    `expected counterfactualNoRoutingCostUsd ~${expectedCounterfactual}, got ${lines[1].counterfactualNoRoutingCostUsd}`
  );

  agent.destroy();
  router.close();
  fake.close();
});

test("routes /v1/messages even when the client appends a query string", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    text: "ok",
  }));
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    mode: "shadow",
    ledgerPath,
    classify: async () => ({
      choice: "sonnet",
      confidence: 0.8,
      probabilities: { haiku: 0.05, sonnet: 0.8, opus: 0.1, fable: 0.05 },
    }),
  });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(readLedger(ledgerPath).length, 1);

  router.close();
  fake.close();
});

test("forwards an endpoint it does not route instead of 404ing it", async () => {
  const fake = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  const fakePort = await listen(fake);
  const router = createProxyServer({ upstream: `http://127.0.0.1:${fakePort}`, mode: "shadow" });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: "/v1/messages/count_tokens", method: "POST" });

  router.close();
  fake.close();
});

test("aborts the upstream request when the client hangs up mid-turn", async () => {
  let upstreamAborted = false;
  const servers: { router?: ReturnType<typeof createProxyServer>; fake?: ReturnType<typeof createServer> } = {};

  const sawAbort = new Promise<void>((resolve) => {
    servers.fake = createServer((upstreamReq, upstreamRes) => {
      upstreamReq.on("close", () => {
        if (!upstreamRes.writableFinished) {
          upstreamAborted = true;
          resolve();
        }
      });
      // Never respond: hold the turn open so the client can hang up first.
    });
    listen(servers.fake).then(async (fakePort) => {
      servers.router = createProxyServer({
        upstream: `http://127.0.0.1:${fakePort}`,
        mode: "shadow",
        classify: async () => null,
      });
      const port = await listen(servers.router);
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
        signal: controller.signal,
      }).catch(() => {});
      setTimeout(() => controller.abort(), 50);
      await pending;
    });
  });

  await sawAbort;
  assert.equal(upstreamAborted, true);
  if (servers.router) servers.router.close();
  if (servers.fake) servers.fake.close();
});

test("the ledger's logged upgradeMargin respects ROUTER_MAX_TIER instead of the haiku..fable default", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", ledgerMarginsFixture], {
    encoding: "utf8",
    env: { ...process.env, ROUTER_MAX_TIER: "sonnet" },
  });
  const { upgradeMargin } = JSON.parse(output);
  // With ROUTER_MAX_TIER=sonnet, opus is out of bounds, so there's no
  // upgrade candidate left within the ceiling and the margin serializes
  // as null (JSON has no -Infinity). The pre-fix version ignored the
  // ceiling and reported opus's margin (0.75 - 0.15 = 0.6) instead.
  assert.equal(upgradeMargin, null);
});

test("rejects a request that carries browser provenance", async () => {
  const router = createProxyServer({ mode: "shadow" });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
  });
  assert.equal(response.status, 403);

  router.close();
});

test("rejects a non-JSON content type on the routed endpoint", async () => {
  const router = createProxyServer({ mode: "shadow" });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
  });
  assert.equal(response.status, 415);

  router.close();
});

test("rejects a body past the size cap instead of buffering it", async () => {
  const router = createProxyServer({ mode: "shadow", maxBodyBytes: 1024 });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5", pad: "x".repeat(4096), messages: [] }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "request_too_large" });

  router.close();
});

test("respects ROUTER_MAX_BODY_BYTES environment variable when no explicit option is passed", async () => {
  const savedEnv = process.env.ROUTER_MAX_BODY_BYTES;
  try {
    process.env.ROUTER_MAX_BODY_BYTES = "1024";
    const router = createProxyServer({ mode: "shadow" });
    const port = await listen(router);

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", pad: "x".repeat(4096), messages: [] }),
    });
    assert.equal(response.status, 413);

    router.close();
  } finally {
    if (savedEnv === undefined) {
      delete process.env.ROUTER_MAX_BODY_BYTES;
    } else {
      process.env.ROUTER_MAX_BODY_BYTES = savedEnv;
    }
  }
});

test("treats an empty ROUTER_MAX_BODY_BYTES as unset instead of a 0-byte cap", async () => {
  const savedEnv = process.env.ROUTER_MAX_BODY_BYTES;
  try {
    // Number("") is 0, not NaN - a blank env var must not silently cap
    // every request body at 0 bytes.
    process.env.ROUTER_MAX_BODY_BYTES = "";
    const fake = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [], usage: {} }));
    });
    const fakePort = await listen(fake);
    const router = createProxyServer({
      mode: "shadow",
      upstream: `http://127.0.0.1:${fakePort}`,
      classify: async () => null,
    });
    const port = await listen(router);

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [] }),
    });
    assert.notEqual(response.status, 413);

    router.close();
    fake.close();
  } finally {
    if (savedEnv === undefined) {
      delete process.env.ROUTER_MAX_BODY_BYTES;
    } else {
      process.env.ROUTER_MAX_BODY_BYTES = savedEnv;
    }
  }
});
