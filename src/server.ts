import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getOrInitState, updateState } from "./conversationKey.js";
import { decide } from "./policy.js";
import { computeMargins } from "./margins.js";
import { classifyTurn, type ClassifyInput } from "./classify.js";
import { DEFAULT_PRICING, tierForModel } from "./pricing.js";
import { appendLedgerLine, computeCostUsd } from "./ledger.js";
import { buildUpgradeNoteBlock } from "./upgradeNote.js";
import type { PricingConfig, Tier, ClassifyResult } from "./types.js";

export interface ServerOptions {
  upstream?: string;
  mode?: "shadow" | "live";
  ledgerPath?: string;
  pricing?: PricingConfig;
  classify?: (input: ClassifyInput) => Promise<ClassifyResult | null>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function extractLatestUserText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        const textBlock = m.content.find((b: any) => b.type === "text");
        return textBlock?.text ?? "";
      }
    }
  }
  return "";
}

export async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions = {}
): Promise<void> {
  const upstream = options.upstream ?? "https://api.anthropic.com";
  const mode = options.mode ?? (process.env.ROUTER_MODE === "live" ? "live" : "shadow");
  const ledgerPath =
    options.ledgerPath ?? process.env.ROUTER_LEDGER_PATH ?? "./router-ledger.jsonl";
  const pricing = options.pricing ?? DEFAULT_PRICING;
  const classify = options.classify ?? classifyTurn;

  const bodyBuf = await readBody(req);
  const body = JSON.parse(bodyBuf.toString("utf8"));
  const requestedModel: string = body.model;
  const initialTier: Tier = tierForModel(pricing, requestedModel) ?? "sonnet";
  const state = getOrInitState(req.socket, initialTier);

  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const latestUserMessage = extractLatestUserText(messages);

  const classification = await classify({
    recentMessages: messages.slice(-6),
    latestUserMessage,
  });

  const marginInfo = classification
    ? computeMargins(classification.probabilities, state.currentTier)
    : null;

  const decision = classification
    ? decide(classification, state, messages, pricing)
    : ({ kind: "held" } as const);

  let outgoingModel = requestedModel;
  const isSwitch =
    decision.kind === "downgraded" ||
    decision.kind === "downgraded-on-reset" ||
    decision.kind === "upgraded-on-reset";

  if (mode === "live" && isSwitch) {
    outgoingModel = pricing.modelAlias[decision.to];
    body.model = outgoingModel;
  }

  if (decision.kind === "upgrade-suggested" && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (last.role === "user") {
      const note = buildUpgradeNoteBlock(decision.to, decision.estimatedCostUsd);
      const content = Array.isArray(last.content)
        ? [...last.content, note]
        : [{ type: "text", text: String(last.content ?? "") }, note];
      body.messages = [...messages.slice(0, -1), { ...last, content }];
    }
  }

  const upstreamHeaders = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") upstreamHeaders.set(key, value);
    else if (Array.isArray(value)) upstreamHeaders.set(key, value.join(", "));
  }
  upstreamHeaders.delete("host");
  upstreamHeaders.delete("content-length");

  const upstreamResponse = await fetch(`${upstream}/v1/messages`, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(body),
  });

  res.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers.entries()));

  const usage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const actualModel = mode === "live" ? outgoingModel : requestedModel;
  const actualTier = tierForModel(pricing, actualModel) ?? state.currentTier;

  if (upstreamResponse.body) {
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      buffered += decoder.decode(value, { stream: true });
      for (const match of buffered.matchAll(/"usage"\s*:\s*(\{[^}]*\})/g)) {
        try {
          const parsed = JSON.parse(match[1]);
          usage.inputTokens = parsed.input_tokens ?? usage.inputTokens;
          usage.outputTokens = parsed.output_tokens ?? usage.outputTokens;
          usage.cacheCreationTokens =
            parsed.cache_creation_input_tokens ?? usage.cacheCreationTokens;
          usage.cacheReadTokens = parsed.cache_read_input_tokens ?? usage.cacheReadTokens;
        } catch {
          // partial match straddling a chunk boundary; more bytes will complete it
        }
      }
    }
  }
  res.end();

  updateState(
    state,
    actualTier,
    {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_creation_input_tokens: usage.cacheCreationTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
    },
    messages
  );

  const actualCostUsd = computeCostUsd(
    pricing,
    actualTier,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheCreationTokens,
    usage.cacheReadTokens
  );
  const counterfactualNoRoutingCostUsd = computeCostUsd(
    pricing,
    initialTier,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheCreationTokens,
    usage.cacheReadTokens
  );

  appendLedgerLine(ledgerPath, {
    ts: new Date().toISOString(),
    conversationKey: "socket",
    probabilities: classification?.probabilities ?? ({} as Record<Tier, number>),
    downgradeMargin: marginInfo?.downgradeMargin ?? 0,
    upgradeMargin: marginInfo?.upgradeMargin ?? 0,
    decision: decision.kind,
    resetDetected:
      decision.kind === "downgraded-on-reset" || decision.kind === "upgraded-on-reset",
    suggestedUpgradeTo: decision.kind === "upgrade-suggested" ? decision.to : null,
    suggestedUpgradeCostUsd:
      decision.kind === "upgrade-suggested" ? decision.estimatedCostUsd : null,
    actualModel,
    actualTier,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    actualCostUsd,
    counterfactualNoRoutingCostUsd,
  });
}

export function createProxyServer(options: ServerOptions = {}) {
  return createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/messages") {
      handleMessages(req, res, options).catch((err) => {
        console.error("router error", err);
        if (!res.headersSent) res.writeHead(502);
        res.end(JSON.stringify({ error: "router_proxy_error" }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8787);
  createProxyServer().listen(port, () => {
    const mode = process.env.ROUTER_MODE === "live" ? "live" : "shadow";
    console.log(`typesafe-claude-router listening on http://localhost:${port} (mode=${mode})`);
  });
}
