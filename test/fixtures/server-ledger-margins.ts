// Fixture for server.test.ts: DEFAULT_LIMITS (and therefore the tier
// ceiling/floor computeMargins should respect) is read from env vars once,
// at module load time, so proving the ledger's logged margins honor
// ROUTER_MAX_TIER needs a fresh process - re-importing the already-loaded
// module in server.test.ts's own process wouldn't re-run that top-level read.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createProxyServer } from "../../src/server.js";
import { readLedger } from "../../src/ledger.js";
import { DEFAULT_PRICING } from "../../src/pricing.js";

async function main() {
  const fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "message",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 10, output_tokens: 10 },
        })
      );
    });
  });
  const fakePort: number = await new Promise((resolve) => {
    fake.listen(0, () => {
      const address = fake.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.jsonl");
  const router = createProxyServer({
    upstream: `http://127.0.0.1:${fakePort}`,
    ledgerPath,
    // Strongest probability is opus, which sits above ROUTER_MAX_TIER=sonnet.
    classify: async () => ({
      choice: "sonnet",
      confidence: 0.8,
      probabilities: { haiku: 0.05, sonnet: 0.15, opus: 0.75, fable: 0.05 },
    }),
  });
  const port: number = await new Promise((resolve) => {
    router.listen(0, () => {
      const address = router.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_PRICING.modelAlias.sonnet,
      tools: [{ name: "Read" }],
      messages: [{ role: "user", content: "hello" }],
    }),
  }).then((r) => r.text());

  const [line] = readLedger(ledgerPath);
  router.close();
  fake.close();
  // appendLedgerLine round-trips through JSON, which serializes -Infinity
  // as null, so a capped-out margin reads back as null here.
  console.log(JSON.stringify({ upgradeMargin: line.upgradeMargin }));
}

main();
