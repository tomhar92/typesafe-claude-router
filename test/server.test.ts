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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Claude Code's main-thread and subagent requests always carry tools; a
// request with none is treated as a side call and never routed.
const TOOLS = [{ name: "Read" }];

const ledgerMarginsFixture = fileURLToPath(
  new URL("./fixtures/server-ledger-margins.ts", import.meta.url)
);

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
  let lastHeaders: Record<string, unknown> = {};
  const fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      lastHeaders = req.headers;
      const { status, usage, text } = respond(lastBody);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", content: [{ type: "text", text }], stop_reason: "end_turn", usage }));
    });
  });
  const port = await listen(fake);
  return { url: `http://127.0.0.1:${port}`, close: () => fake.close(), getLastBody: () => lastBody, getLastHeaders: () => lastHeaders };
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
      tools: TOOLS, messages: [{ role: "user", content: "hello" }],
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
      tools: TOOLS, messages: [{ role: "user", content: "hello" }],
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
      tools: TOOLS, messages: [{ role: "user", content: "first turn on this connection" }],
    }),
  });

  assert.equal(fake.getLastBody().model, DEFAULT_PRICING.modelAlias.haiku);

  const lines = readLedger(ledgerPath);
  assert.equal(lines[0].decision, "downgraded-on-reset");

  router.close();
  fake.close();
});

test("reshapes a Sonnet-built request for Haiku: caps, thinking, effort, system messages and beta flags", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
    text: "ok",
  }));

  const router = createProxyServer({
    upstream: fake.url,
    ledgerPath: join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl"),
    classify: async () => ({
      choice: "haiku",
      confidence: 0.9,
      probabilities: { haiku: 0.9, sonnet: 0.05, opus: 0.03, fable: 0.02 },
    }),
  });
  const port = await listen(router);

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "claude-code-20250219,mid-conversation-system-2026-04-07,effort-2025-11-24,context-management-2025-06-27",
    },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      max_tokens: 128000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tools: TOOLS,
      messages: [
        { role: "user", content: [{ type: "text", text: "are the skies blue?" }] },
        { role: "system", content: [{ type: "text", text: "plan mode is on" }] },
      ],
    }),
  });

  const sent = fake.getLastBody();
  assert.equal(sent.model, DEFAULT_PRICING.modelAlias.haiku);
  assert.equal(sent.max_tokens, 32000);
  assert.deepEqual(sent.thinking, { type: "enabled", budget_tokens: 31999 });
  assert.equal("output_config" in sent, false);
  assert.deepEqual(sent.messages.map((m: any) => m.role), ["user"]);
  assert.equal(sent.messages[0].content.length, 2);
  assert.match(sent.messages[0].content[1].text, /plan mode is on/);
  assert.equal(fake.getLastHeaders()["anthropic-beta"], "claude-code-20250219,context-management-2025-06-27");

  router.close();
  fake.close();
});

test("leaves the request body and beta header alone when the tier is not rewritten", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    text: "ok",
  }));
  const router = createProxyServer({
    upstream: fake.url,
    ledgerPath: join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl"),
    classify: async () => ({
      choice: "sonnet",
      confidence: 0.9,
      probabilities: { haiku: 0.05, sonnet: 0.9, opus: 0.03, fable: 0.02 },
    }),
  });
  const port = await listen(router);

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-beta": "effort-2025-11-24" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      max_tokens: 128000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tools: TOOLS,
      messages: [{ role: "user", content: "hi" }, { role: "system", content: "x" }],
    }),
  });

  const sent = fake.getLastBody();
  assert.equal(sent.max_tokens, 128000);
  assert.deepEqual(sent.thinking, { type: "adaptive" });
  assert.deepEqual(sent.messages.map((m: any) => m.role), ["user", "system"]);
  assert.equal(fake.getLastHeaders()["anthropic-beta"], "effort-2025-11-24");

  router.close();
  fake.close();
});

test("a conversation that moves to a new connection is not mistaken for a reset", async () => {
  let calls = 0;
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
    text: "ok",
  }));
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    ledgerPath,
    classify: async () => {
      calls += 1;
      return calls === 1
        ? { choice: "haiku", confidence: 0.95, probabilities: { haiku: 0.95, sonnet: 0.03, opus: 0.01, fable: 0.01 } }
        : { choice: "opus", confidence: 0.95, probabilities: { haiku: 0.01, sonnet: 0.02, opus: 0.95, fable: 0.02 } };
    },
  });
  const port = await listen(router);

  const first = { role: "user", content: [{ type: "text", text: "easy first prompt" }] };
  const reply = { role: "assistant", content: [{ type: "text", text: "ok" }] };
  const second = { role: "user", content: [{ type: "text", text: "now something hard" }] };
  // Claude Code keeps asking for its own default every turn.
  const model = DEFAULT_PRICING.modelAlias.sonnet;

  // Turn one on one connection, turn two (same conversation, grown history)
  // on a brand-new one - the situation that used to read as a reset and
  // upgrade without asking.
  const a = new Agent({ keepAlive: true });
  const b = new Agent({ keepAlive: true });
  await postOnSharedSocket(a, port, { model, tools: TOOLS, messages: [first] });
  await postOnSharedSocket(b, port, { model, tools: TOOLS, messages: [first, reply, second] });
  a.destroy();
  b.destroy();

  const lines = readLedger(ledgerPath);
  assert.equal(lines[0].decision, "downgraded-on-reset");
  assert.equal(lines[1].conversationKey, lines[0].conversationKey);
  assert.equal(lines[1].decision, "upgrade-suggested");
  assert.equal(lines[1].actualModel, DEFAULT_PRICING.modelAlias.haiku);

  router.close();
  fake.close();
});

test("a different first message on the same connection is a separate conversation", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    text: "ok",
  }));
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    ledgerPath,
    classify: async () => ({
      choice: "sonnet",
      confidence: 0.9,
      probabilities: { haiku: 0.05, sonnet: 0.9, opus: 0.03, fable: 0.02 },
    }),
  });
  const port = await listen(router);

  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const model = DEFAULT_PRICING.modelAlias.sonnet;
  await postOnSharedSocket(agent, port, { model, tools: TOOLS, messages: [{ role: "user", content: "task one" }] });
  await postOnSharedSocket(agent, port, { model, tools: TOOLS, messages: [{ role: "user", content: "task two" }] });
  agent.destroy();

  const lines = readLedger(ledgerPath);
  assert.notEqual(lines[0].conversationKey, lines[1].conversationKey);

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
    tools: TOOLS, messages: turn1Messages,
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
    tools: TOOLS, messages: turn2Messages,
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
      tools: TOOLS, messages: [{ role: "user", content: "hello" }],
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
    tools: TOOLS, messages: turn1Messages,
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
    tools: TOOLS, messages: turn2Messages,
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
    ledgerPath,
    classify: async () => null,
  });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      tools: TOOLS, messages: [{ role: "user", content: "hi" }],
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
        tools: TOOLS, messages: [{ role: "user", content: "hi" }],
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
      tools: TOOLS, messages: [{ role: "user", content: "hi" }],
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
    ledgerPath,
    classify: async () => null, // simulates a TypeSafe timeout/error
  });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      tools: TOOLS, messages: [{ role: "user", content: "hi" }],
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

test("does not classify a tool-result continuation, and logs it as its own decision", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    text: "ok",
  }));
  let classifyCalls = 0;
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    ledgerPath,
    classify: async () => {
      classifyCalls += 1;
      return {
        choice: "haiku",
        confidence: 0.9,
        probabilities: { haiku: 0.9, sonnet: 0.05, opus: 0.03, fable: 0.02 },
      };
    },
  });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      tools: TOOLS, messages: [
        { role: "user", content: "fix it" },
        { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "text" }] },
      ],
    }),
  });
  await response.text();

  assert.equal(classifyCalls, 0);
  const lines = readLedger(ledgerPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].decision, "skipped-tool-result");
  assert.equal(lines[0].actualTier, "sonnet");

  router.close();
  fake.close();
});

test("a tool-less side request is forwarded and logged but never classified or counted as a turn", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    text: "ok",
  }));
  let classifyCalls = 0;
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: fake.url,
    ledgerPath,
    classify: async () => {
      classifyCalls += 1;
      return {
        choice: "haiku",
        confidence: 0.9,
        probabilities: { haiku: 0.9, sonnet: 0.05, opus: 0.03, fable: 0.02 },
      };
    },
  });
  const port = await listen(router);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const model = DEFAULT_PRICING.modelAlias.sonnet;
  const mainMessages = [{ role: "user", content: "refactor the parser" }];

  await postOnSharedSocket(agent, port, { model, tools: TOOLS, messages: mainMessages });
  // A side call on the same socket, with unrelated messages and no tools.
  await postOnSharedSocket(agent, port, { model, max_tokens: 1, messages: [{ role: "user", content: "quota" }] });
  // The main thread continues; it must not look like a reset.
  await postOnSharedSocket(agent, port, {
    model,
    tools: TOOLS,
    messages: [...mainMessages, { role: "assistant", content: "done" }, { role: "user", content: "now the lexer" }],
  });

  assert.equal(classifyCalls, 2);
  const lines = readLedger(ledgerPath);
  assert.deepEqual(
    lines.map((l) => l.decision),
    ["downgraded-on-reset", "side-request", "held"]
  );
  assert.equal(lines[1].conversationKey, "side-request");
  assert.equal(lines[2].resetDetected, false);

  agent.destroy();
  router.close();
  fake.close();
});

test("an upgrade suggestion is added to the reply the user sees, and the request goes upstream unchanged", async () => {
  const fake = await withFakeUpstream(() => ({
    status: 200,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    text: "here is my answer",
  }));

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  let call = 0;
  const router = createProxyServer({
    upstream: fake.url,
    ledgerPath,
    classify: async () => {
      call += 1;
      // Turn 1 settles on sonnet at the reset; turn 2 is a normal append,
      // so the margin-based "upgrade-suggested" path is the one under test.
      return call === 1
        ? { choice: "sonnet", confidence: 0.8, probabilities: { haiku: 0.05, sonnet: 0.8, opus: 0.1, fable: 0.05 } }
        : { choice: "opus", confidence: 0.7, probabilities: { haiku: 0.05, sonnet: 0.15, opus: 0.7, fable: 0.1 } };
    },
  });
  const port = await listen(router);
  const post = (messages: unknown[]) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: DEFAULT_PRICING.modelAlias.sonnet, tools: TOOLS, messages }),
    }).then((r) => r.json() as Promise<any>);

  const turn1 = [{ role: "user", content: "first turn" }];
  const first = await post(turn1);
  assert.equal(first.content.length, 1);

  const turn2 = [...turn1, { role: "assistant", content: "ok" }, { role: "user", content: "a genuinely hard question" }];
  const second = await post(turn2);

  const lines = readLedger(ledgerPath);
  assert.equal(lines[1].decision, "upgrade-suggested");
  // The model's own answer is untouched; the router's note follows it.
  assert.equal(second.content[0].text, "here is my answer");
  assert.equal(second.content.length, 2);
  assert.match(second.content[1].text, /Router note/);
  assert.match(second.content[1].text, /\/model opus/);
  // What the model saw is exactly what Claude Code sent.
  assert.deepEqual(fake.getLastBody().messages, turn2);

  router.close();
  fake.close();
});

test("a streamed reply gets the upgrade note as a final text block Claude Code can render", async () => {
  const sseEvent = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const sseBody =
    sseEvent("message_start", { message: { usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) +
    sseEvent("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    sseEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text: "streamed answer" } }) +
    sseEvent("content_block_stop", { index: 0 }) +
    sseEvent("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }) +
    sseEvent("message_stop", {});
  const upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Split mid-event to prove the relay reassembles before deciding.
      res.write(sseBody.slice(0, 120));
      res.end(sseBody.slice(120));
    });
  });
  const upstreamPort = await listen(upstream);

  let call = 0;
  const router = createProxyServer({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    ledgerPath: join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl"),
    classify: async () => {
      call += 1;
      return call === 1
        ? { choice: "sonnet", confidence: 0.8, probabilities: { haiku: 0.05, sonnet: 0.8, opus: 0.1, fable: 0.05 } }
        : { choice: "opus", confidence: 0.7, probabilities: { haiku: 0.05, sonnet: 0.15, opus: 0.7, fable: 0.1 } };
    },
  });
  const port = await listen(router);
  const post = (messages: unknown[]) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: DEFAULT_PRICING.modelAlias.sonnet, tools: TOOLS, stream: true, messages }),
    }).then((r) => r.text());

  const turn1 = [{ role: "user", content: "first turn" }];
  assert.ok(!(await post(turn1)).includes("Router note"));
  const text = await post([...turn1, { role: "assistant", content: "ok" }, { role: "user", content: "hard question" }]);

  const parsed = text.split("\n\n").filter(Boolean).map((e) => JSON.parse(e.split("\n")[1].slice(6)));
  assert.deepEqual(
    parsed.map((e) => e.type),
    ["message_start", "content_block_start", "content_block_delta", "content_block_stop",
     "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]
  );
  assert.equal(parsed[4].index, 1);
  assert.match(parsed[5].delta.text, /Router note/);

  router.close();
  upstream.close();
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
    body: JSON.stringify({ model: "gpt-4o", tools: TOOLS, messages: [{ role: "user", content: "hi" }] }),
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
    body: JSON.stringify({ tools: TOOLS, messages: [{ role: "user", content: "hi" }] }),
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
  await postOnSharedSocket(agent, port, { model: "gpt-4o", tools: TOOLS, messages: turn1Messages });

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
    tools: TOOLS, messages: turn2Messages,
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
      tools: TOOLS, messages: [{ role: "user", content: "hello" }],
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
    tools: TOOLS, messages: turn1Messages,
  });

  const turn2Messages = [
    ...turn1Messages,
    { role: "assistant", content: "ok" },
    { role: "user", content: "second turn" },
  ];
  await postOnSharedSocket(agent, port, {
    model: DEFAULT_PRICING.modelAlias.sonnet,
    tools: TOOLS, messages: turn2Messages,
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
      tools: TOOLS, messages: [{ role: "user", content: "hello" }],
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
  const router = createProxyServer({ upstream: `http://127.0.0.1:${fakePort}` });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5", tools: TOOLS, messages: [] }),
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
        classify: async () => null,
      });
      const port = await listen(servers.router);
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5", tools: TOOLS, messages: [{ role: "user", content: "hi" }] }),
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
  const router = createProxyServer();
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ model: "claude-sonnet-5", tools: TOOLS, messages: [] }),
  });
  assert.equal(response.status, 403);

  router.close();
});

test("rejects a non-JSON content type on the routed endpoint", async () => {
  const router = createProxyServer();
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ model: "claude-sonnet-5", tools: TOOLS, messages: [] }),
  });
  assert.equal(response.status, 415);

  router.close();
});

test("rejects a body past the size cap instead of buffering it", async () => {
  const router = createProxyServer({ maxBodyBytes: 1024 });
  const port = await listen(router);

  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5", pad: "x".repeat(4096), tools: TOOLS, messages: [] }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "request_too_large" });

  router.close();
});

test("respects ROUTER_MAX_BODY_BYTES environment variable when no explicit option is passed", async () => {
  const savedEnv = process.env.ROUTER_MAX_BODY_BYTES;
  try {
    process.env.ROUTER_MAX_BODY_BYTES = "1024";
    const router = createProxyServer();
    const port = await listen(router);

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", pad: "x".repeat(4096), tools: TOOLS, messages: [] }),
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
      upstream: `http://127.0.0.1:${fakePort}`,
      classify: async () => null,
    });
    const port = await listen(router);

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", tools: TOOLS, messages: [] }),
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
