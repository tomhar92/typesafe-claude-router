import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getOrInitState, updateState } from "./conversationKey.js";
import { decide } from "./policy.js";
import { computeMargins } from "./margins.js";
import { classifyTurn, type ClassifyInput } from "./classify.js";
import { DEFAULT_PRICING, tierForModel, computeCostUsd } from "./pricing.js";
import { appendLedgerLine } from "./ledger.js";
import { buildUpgradeNoteBlock } from "./upgradeNote.js";
import { UsageAccumulator } from "./usage.js";
import { isMainModule } from "./isMainModule.js";
import type { PricingConfig, Tier, ClassifyResult } from "./types.js";

export interface ServerOptions {
  upstream?: string;
  mode?: "shadow" | "live";
  ledgerPath?: string;
  pricing?: PricingConfig;
  classify?: (input: ClassifyInput) => Promise<ClassifyResult | null>;
}

// Headers that describe the *transport* framing of the upstream response
// rather than its content. Forwarding them verbatim is wrong here: fetch
// (undici) auto-decompresses gzip/deflate/br bodies but leaves the
// original `content-encoding`/`content-length` in `response.headers`, so
// blindly copying them makes our response claim to be compressed (or a
// stale byte length) when the bytes we actually wrote are plain and a
// different length. `transfer-encoding`/`connection` are similarly
// per-hop, not per-resource, and Node's http server manages them itself.
const HOP_BY_HOP_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
];

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
  let body: any;
  try {
    body = JSON.parse(bodyBuf.toString("utf8"));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_request_body" }));
    return;
  }

  const requestedModel: string = body.model;
  const requestedTier: Tier = tierForModel(pricing, requestedModel) ?? "sonnet";
  const state = getOrInitState(req.socket, requestedTier);

  // Claude Code re-sends whatever tier it thinks the session is on. If that
  // no longer matches what we tracked last turn, the user changed it
  // out-of-band (e.g. `/model opus`) - honor that immediately instead of
  // silently sticking to the router's last pick below. The cache is being
  // rebuilt by the model change regardless, so there's no switch-tax reason
  // to fight it.
  const userChangedModel = requestedTier !== state.lastRequestedTier;
  state.lastRequestedTier = requestedTier;
  if (userChangedModel) {
    state.currentTier = requestedTier;
  }

  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const latestUserMessage = extractLatestUserText(messages);

  const classification = await classify({
    recentMessages: messages.slice(-6),
    latestUserMessage,
  });
  if (!classification) {
    console.warn(
      "typesafe-claude-router: classifier unavailable this turn (TypeSafe error or timeout) - holding current tier"
    );
  }

  const marginInfo = classification
    ? computeMargins(classification.probabilities, state.currentTier)
    : null;

  const decision = classification
    ? decide(classification, state, messages, pricing)
    : ({ kind: "held" } as const);

  const isSwitch =
    decision.kind === "downgraded" ||
    decision.kind === "downgraded-on-reset" ||
    decision.kind === "upgraded-on-reset";

  // A "held" (or upgrade-suggested, which never auto-switches) decision
  // means: stay on the tier the router already put this conversation on,
  // not "revert to whatever Claude Code's own request happens to say" -
  // Claude Code keeps resending its own default every turn, so falling
  // back to `requestedModel` here undid every downgrade after exactly one
  // turn and paid the cache-rebuild tax again going back.
  const targetTier: Tier = isSwitch ? decision.to : state.currentTier;

  let outgoingModel = requestedModel;
  if (mode === "live") {
    outgoingModel = pricing.modelAlias[targetTier];
    body.model = outgoingModel;
  }

  // Shadow mode's whole contract is "never change what actually happens,
  // only log what would have happened." Injecting this note into the
  // conversation content the model sees is a real behavior change (it can
  // change what the model says to the user), so it's gated to live mode
  // like the model-field rewrite above - otherwise "shadow mode" was
  // quietly not shadow for this one feature.
  if (mode === "live" && decision.kind === "upgrade-suggested" && messages.length > 0) {
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

  const responseHeaders = Object.fromEntries(upstreamResponse.headers.entries());
  for (const header of HOP_BY_HOP_RESPONSE_HEADERS) delete responseHeaders[header];
  res.writeHead(upstreamResponse.status, responseHeaders);

  const actualModel = mode === "live" ? outgoingModel : requestedModel;
  const actualTier = tierForModel(pricing, actualModel) ?? targetTier;

  const usageAccumulator = new UsageAccumulator();
  if (upstreamResponse.body) {
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      usageAccumulator.push(decoder.decode(value, { stream: true }));
    }
  }
  res.end();
  const usage = usageAccumulator.finalize();

  // A non-2xx upstream response (rate limit, auth failure, malformed
  // request, ...) didn't deliver a real turn - the conversation didn't
  // advance and there's no trustworthy usage to log. Recording it as if it
  // had would poison both the sticky-tier state and the cost report.
  if (upstreamResponse.ok) {
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

    // The counterfactual answers "what would this turn have cost with no
    // router at all", i.e. staying on `requestedTier` forever. A plain
    // "downgraded" decision is the one case where *this turn's* cache-write
    // tokens exist only because the router itself just switched models - in
    // the no-router world the session never left `requestedTier`, so that
    // prefix would still have been warm (a cache *read*, at requestedTier's
    // much cheaper rate) rather than rebuilt. Reset-triggered switches don't
    // get this treatment: the reset (session start, `/clear`, `/compact`)
    // invalidates the cache regardless of the router, so the no-router world
    // pays that same rebuild too.
    const routerCausedRebuild = decision.kind === "downgraded";
    const counterfactualCacheReadTokens = routerCausedRebuild
      ? usage.cacheReadTokens + usage.cacheCreationTokens
      : usage.cacheReadTokens;
    const counterfactualCacheCreationTokens = routerCausedRebuild ? 0 : usage.cacheCreationTokens;
    const counterfactualNoRoutingCostUsd = computeCostUsd(
      pricing,
      requestedTier,
      usage.inputTokens,
      usage.outputTokens,
      counterfactualCacheCreationTokens,
      counterfactualCacheReadTokens
    );

    appendLedgerLine(ledgerPath, {
      ts: new Date().toISOString(),
      conversationKey: state.connectionId,
      probabilities: classification?.probabilities ?? ({} as Record<Tier, number>),
      confidence: classification?.confidence ?? null,
      downgradeMargin: marginInfo?.downgradeMargin ?? 0,
      upgradeMargin: marginInfo?.upgradeMargin ?? 0,
      decision: classification ? decision.kind : "classifier-unavailable",
      resetDetected:
        decision.kind === "downgraded-on-reset" || decision.kind === "upgraded-on-reset",
      suggestedUpgradeTo: decision.kind === "upgrade-suggested" ? decision.to : null,
      suggestedUpgradeCostUsd:
        decision.kind === "upgrade-suggested" ? decision.estimatedCostUsd : null,
      actualModel,
      actualTier,
      turnsOnCurrentTier: state.turnsOnCurrentTier,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      cacheReadTokens: usage.cacheReadTokens,
      actualCostUsd,
      counterfactualNoRoutingCostUsd,
    });
  }
}

export function createProxyServer(options: ServerOptions = {}) {
  return createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/messages") {
      handleMessages(req, res, options).catch((err) => {
        console.error("router error", err);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "router_proxy_error" }));
          return;
        }
        // Headers (and possibly a partial SSE body) already went out.
        // Appending an error JSON blob after them would corrupt the
        // stream instead of signaling failure - destroy the connection so
        // the client sees a clearly incomplete response.
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

if (isMainModule(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  // Default to loopback-only: this proxy holds no auth of its own (it
  // relies on whatever ANTHROPIC_API_KEY the client already sends
  // through), so binding to all interfaces would let anyone else on the
  // network trigger paid TypeSafe classifier calls and grow the ledger
  // file through this machine. Set HOST to opt into listening more
  // broadly (e.g. inside a container).
  const host = process.env.HOST ?? "127.0.0.1";
  createProxyServer().listen(port, host, () => {
    const mode = process.env.ROUTER_MODE === "live" ? "live" : "shadow";
    console.log(`typesafe-claude-router listening on http://${host}:${port} (mode=${mode})`);
  });
}
