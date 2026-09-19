import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
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
