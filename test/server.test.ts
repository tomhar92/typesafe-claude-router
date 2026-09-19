import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, Agent } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
