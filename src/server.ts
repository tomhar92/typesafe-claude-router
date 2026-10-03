import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { conversationKeyFor, getOrInitState, updateState } from "./conversationKey.js";
import { decide, DEFAULT_LIMITS } from "./policy.js";
import { computeMargins } from "./margins.js";
import { classifyTurn, type ClassifyInput, type ClassifyOptions } from "./classify.js";
import { DEFAULT_PRICING, tierForModel, computeCostUsd } from "./pricing.js";
import { appendLedgerLine } from "./ledger.js";
import { extractLatestUserText, sanitizeForClassifier } from "./classifyInput.js";
import { buildUpgradeNoteBlock } from "./upgradeNote.js";
import { UsageAccumulator, type UsageTotals } from "./usage.js";
import { isMainModule } from "./isMainModule.js";
import type { PricingConfig, Tier, ClassifyResult } from "./types.js";

export interface ServerOptions {
  upstream?: string;
  mode?: "shadow" | "live";
  ledgerPath?: string;
  pricing?: PricingConfig;
  classify?: (input: ClassifyInput, options?: ClassifyOptions) => Promise<ClassifyResult | null>;
  /** Hard cap on a buffered request body. Default 64 MiB, or
   * ROUTER_MAX_BODY_BYTES. */
  maxBodyBytes?: number;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds the configured limit");
    this.name = "BodyTooLargeError";
  }
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

function requestPath(url: string | undefined): string {
  // Matching `req.url === "/v1/messages"` failed on any query string, so
  // a client appending `?beta=true` got a 404 from a proxy whose whole
  // job is to be transparent. Parse against a dummy origin so only the
  // pathname decides routing.
  try {
    return new URL(url ?? "/", "http://router.invalid").pathname;
  } catch {
    return "/";
  }
}

const DEFAULT_MAX_BODY_BYTES = 67108864;

function resolveMaxBodyBytes(options: ServerOptions): number {
  if (options.maxBodyBytes !== undefined) {
    return Number.isFinite(options.maxBodyBytes) && options.maxBodyBytes > 0
      ? options.maxBodyBytes
      : DEFAULT_MAX_BODY_BYTES;
  }
  const envLimit = Number(process.env.ROUTER_MAX_BODY_BYTES);
  // Number("") is 0, not NaN, so an env var set to an empty string (a blank
  // .env line, or a shell export of an unset variable) must not pass this
  // check - otherwise every request with a body gets capped at 0 bytes.
  return Number.isFinite(envLimit) && envLimit > 0 ? envLimit : DEFAULT_MAX_BODY_BYTES;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > limit) {
        // Reject without destroying req: req and res share a socket, so
        // destroying it here fires res's own "close" handler before this
        // rejection reaches run.catch, which marks the request as aborted
        // and skips the BodyTooLargeError branch entirely - the client got
        // a connection reset instead of the 413 below. Dropping (not
        // buffering) the remaining chunks still bounds memory; run.catch
        // closes the connection once the 413 response has been sent.
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Both the routed path and the unknown-model bail-out path need to forward
// the request and stream the response back untouched - factored out so
// neither can drift from the other's header-stripping/decompression
// handling.
async function forwardAndStream(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  upstream: string,
  signal: AbortSignal
): Promise<{ response: Response; usage: UsageTotals }> {
  const upstreamHeaders = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") upstreamHeaders.set(key, value);
    else if (Array.isArray(value)) upstreamHeaders.set(key, value.join(", "));
  }
  upstreamHeaders.delete("host");
  upstreamHeaders.delete("content-length");

  const response = await fetch(`${upstream}/v1/messages`, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(body),
    signal,
  });

  const responseHeaders = Object.fromEntries(response.headers.entries());
  for (const header of HOP_BY_HOP_RESPONSE_HEADERS) delete responseHeaders[header];
  res.writeHead(response.status, responseHeaders);

  const accumulator = new UsageAccumulator();
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      accumulator.push(decoder.decode(value, { stream: true }));
    }
  }
  res.end();
  return { response, usage: accumulator.finalize() };
}

// Anything this proxy does not reason about must reach Anthropic
// unchanged. 404ing it made the router opaque for every endpoint except
// the one it rewrites - notably /v1/messages/count_tokens, which the
// client needs for context accounting.
export async function passThroughRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
  signal: AbortSignal
): Promise<void> {
  const upstream = options.upstream ?? "https://api.anthropic.com";
  const maxBodyBytes = resolveMaxBodyBytes(options);
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const bodyBuffer = hasBody ? await readBody(req, maxBodyBytes) : undefined;
  const body = bodyBuffer ? new Uint8Array(bodyBuffer) : undefined;

  const upstreamHeaders = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") upstreamHeaders.set(key, value);
    else if (Array.isArray(value)) upstreamHeaders.set(key, value.join(", "));
  }
  upstreamHeaders.delete("host");
  upstreamHeaders.delete("content-length");

  const response = await fetch(`${upstream}${req.url ?? "/"}`, {
    method,
    headers: upstreamHeaders,
    body,
    signal,
  });

  const responseHeaders = Object.fromEntries(response.headers.entries());
  for (const header of HOP_BY_HOP_RESPONSE_HEADERS) delete responseHeaders[header];
  res.writeHead(response.status, responseHeaders);

  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}

export async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions = {},
  signal: AbortSignal = new AbortController().signal
): Promise<void> {
  const upstream = options.upstream ?? "https://api.anthropic.com";
  const mode = options.mode ?? (process.env.ROUTER_MODE === "live" ? "live" : "shadow");
  const ledgerPath =
    options.ledgerPath ?? process.env.ROUTER_LEDGER_PATH ?? "./router-ledger.jsonl";
  const pricing = options.pricing ?? DEFAULT_PRICING;
  const classify = options.classify ?? classifyTurn;
  const maxBodyBytes = resolveMaxBodyBytes(options);

  const bodyBuf = await readBody(req, maxBodyBytes);
  let body: any;
  try {
    body = JSON.parse(bodyBuf.toString("utf8"));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_request_body" }));
    return;
  }
  // JSON.parse accepts plenty of syntactically-valid bodies that aren't a
  // Messages API request object - `null`, `"foo"`, `42`, `[]`. Those all
  // slip past the try/catch above and then throw on `body.model` below
  // (or silently proceed with nonsense), so reject them here with the same
  // clean 400 rather than letting them fall through to the 502 catch-all.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_request_body" }));
    return;
  }

  const requestedModel: unknown = body.model;
  const requestedTier = tierForModel(pricing, requestedModel);

  // An unrecognized model is not a routing decision we are able to make:
  // we cannot price it, cannot compare tiers against it, and must not
  // guess - the previous `?? "sonnet"` default is what made every dated
  // model ID silently route as Sonnet. Forward it untouched, skip the
  // (billed) classifier call entirely, and still record the turn so the
  // report can surface how often this happens. A run full of
  // `unknown-model` lines means the alias table needs a new entry.
  if (requestedTier === null) {
    const state = getOrInitState(conversationKeyFor(body), "sonnet");
    const { response, usage } = await forwardAndStream(req, res, body, upstream, signal);
    if (response.ok) {
      // The turn still happened and still grew the conversation, even
      // though we couldn't price or route it - lastMessages must move
      // forward so the *next* turn's detectReset() compares against this
      // turn's messages instead of the conversation's initial `[]`. Leaving it
      // stale made any turn right after an unknown-model turn look like a
      // reset, which bypasses decide()'s margin/sticky/break-even
      // safeguards. decisionTier is state.currentTier (unchanged) because
      // this turn made no tier decision to record.
      const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
      updateState(
        state,
        state.currentTier,
        {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_creation_input_tokens: usage.cacheCreationTokens,
          cache_read_input_tokens: usage.cacheReadTokens,
        },
        messages
      );

      appendLedgerLine(ledgerPath, {
        v: 2,
        ts: new Date().toISOString(),
        conversationKey: state.conversationId,
        probabilities:{} as Record<Tier, number>,
        confidence: null,
        downgradeMargin: 0,
        upgradeMargin: 0,
        decision: "unknown-model",
        resetDetected: false,
        suggestedUpgradeTo: null,
        suggestedUpgradeCostUsd: null,
        actualModel: String(requestedModel ?? ""),
        actualTier: null,
        turnsOnCurrentTier: 0,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
        actualCostUsd: null,
        counterfactualNoRoutingCostUsd: null,
      });
    }
    return;
  }

  // tierForModel only returns non-null for a non-empty string model, so
  // everything past this guard can treat the request's model as a plain
  // string rather than the `unknown` it started as.
  const requestedModelString = requestedModel as string;
  const state = getOrInitState(conversationKeyFor(body), requestedTier);

  // Claude Code re-sends whatever tier it thinks the session is on. If that
  // no longer matches what we tracked last turn, the user changed it
  // out-of-band (e.g. `/model opus`) - honor that immediately instead of
  // silently sticking to the router's last pick below. The cache is being
  // rebuilt by the model change regardless, so there's no switch-tax reason
  // to fight it.
  //
  // The mutation below is provisional, for this turn's decide()/margin
  // computation only - it's restored right after targetTier is settled
  // (see below). The *permanent* currentTier transition, and the
  // turnsOnCurrentTier reset/accumulate bookkeeping that goes with it, must
  // go through updateState()'s own comparison against the real pre-turn
  // tier, and only once we know the turn actually succeeded (the
  // upstreamResponse.ok guard further down). Mutating state.currentTier
  // here and leaving it mutated would both double up that bookkeeping and,
  // on a failed upstream call, permanently poison routing state for a turn
  // that never happened.
  //
  // Likewise, state.lastRequestedTier is only committed once we know the
  // turn succeeded (alongside currentTier, further down). If a manual
  // switch's first attempt gets rate-limited or otherwise fails, Claude
  // Code will resend the same requested model on retry - committing
  // lastRequestedTier here unconditionally would mark that switch as
  // "already seen" after the failed attempt, so the retry would silently
  // stop being recognized as a manual change and fall back to pure
  // policy-driven routing instead of honoring it.
  const previousTier = state.currentTier;
  const userChangedModel = requestedTier !== state.lastRequestedTier;
  if (userChangedModel) {
    state.currentTier = requestedTier;
  }

  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  const latestUserMessage = extractLatestUserText(messages);

  // Passing the request signal means a client disconnect cancels the
  // classification too, instead of leaving a billed request in flight.
  const classification = await classify(
    {
      recentMessages: sanitizeForClassifier(messages.slice(-6)),
      latestUserMessage,
    },
    { signal }
  );
  if (!classification) {
    console.warn(
      "typesafe-claude-router: classifier unavailable this turn (TypeSafe error or timeout) - holding current tier"
    );
  }

  const marginInfo = classification
    ? computeMargins(classification.probabilities, state.currentTier, {
        min: DEFAULT_LIMITS.minTier,
        max: DEFAULT_LIMITS.maxTier,
      })
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

  // Undo the provisional mutation above now that this turn's decision is
  // locked in. state.currentTier goes back to reflecting reality (the tier
  // the last *successful* turn actually ended on) until updateState()
  // applies the real transition below.
  state.currentTier = previousTier;

  let outgoingModel = requestedModelString;
  // Only touch the model when routing actually decided to move tiers. A
  // `held` decision means "leave this turn alone"; rewriting anyway
  // clobbers an exact pin (claude-opus-5-20260101) with the bare tier
  // alias, silently changing which snapshot serves the turn while the
  // ledger records it as a no-op.
  if (mode === "live" && targetTier !== requestedTier) {
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

  const { response: upstreamResponse, usage } = await forwardAndStream(req, res, body, upstream, signal);

  const actualModel = mode === "live" ? outgoingModel : requestedModelString;
  const actualTier = tierForModel(pricing, actualModel) ?? targetTier;

  // A non-2xx upstream response (rate limit, auth failure, malformed
  // request, ...) didn't deliver a real turn - the conversation didn't
  // advance and there's no trustworthy usage to log. Recording it as if it
  // had would poison both the sticky-tier state and the cost report.
  if (upstreamResponse.ok) {
    state.lastRequestedTier = requestedTier;
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
      v: 2,
      ts: new Date().toISOString(),
      conversationKey: state.conversationId,
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

// This proxy has no auth of its own, so the risk here is not stolen
// Anthropic credentials - it is that any local process, including a page
// in a browser the user already has open, can drive billed TypeSafe
// classifier calls and grow the ledger through this machine. A simple
// cross-origin POST needs no preflight, so the cheap defence is to
// require JSON and refuse anything carrying browser provenance. No CLI
// client sends either header.
function rejectsAsBrowserRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const site = req.headers["sec-fetch-site"];
  const looksLikeBrowser =
    req.headers.origin !== undefined || (typeof site === "string" && site !== "none");
  if (!looksLikeBrowser) return false;
  res.writeHead(403, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "browser_origin_rejected" }));
  return true;
}

export function createProxyServer(options: ServerOptions = {}) {
  return createServer((req, res) => {
    if (rejectsAsBrowserRequest(req, res)) return;
    // A client that hangs up mid-turn should not leave us paying for a
    // generation nobody will read. `writableFinished` distinguishes a
    // normal end-of-response close from a real disconnect.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort(new Error("client_disconnected"));
    });

    const routed = req.method === "POST" && requestPath(req.url) === "/v1/messages";
    if (routed) {
      const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.includes("application/json")) {
        res.writeHead(415, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported_media_type" }));
        return;
      }
    }

    const run = routed
      ? handleMessages(req, res, options, abort.signal)
      : passThroughRequest(req, res, options, abort.signal);

    run.catch((err) => {
      // The client going away is not a proxy error - there is nobody left
      // to tell, and the socket is already gone.
      if (abort.signal.aborted) return;
      // Expected oversized-body rejections don't log as errors.
      if (err instanceof BodyTooLargeError) {
        if (!res.headersSent) {
          // The client may still be mid-upload - readBody stopped
          // buffering but left the socket open, so refuse to keep it alive
          // (the unread remainder would otherwise corrupt the next
          // pipelined request) and drop it once the response is flushed.
          res.writeHead(413, { "content-type": "application/json", connection: "close" });
          res.end(JSON.stringify({ error: "request_too_large" }));
          res.on("finish", () => req.destroy());
        }
        return;
      }
      console.error("router error", err);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "router_proxy_error" }));
        return;
      }
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

const HOSTED_BACKEND_HOST = "api.typesafe.ai";

/**
 * Configuration problems worth telling the operator about before the
 * first turn rather than one warning line per turn forever. A missing
 * TYPESAFE_API_KEY currently surfaces only as the TypeSafeClient
 * constructor throwing inside classifyTurn's catch, which degrades into
 * `classifier-unavailable` on every turn and looks like a flaky API.
 */
export function validateStartupConfig(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  const baseURL = env.TYPESAFE_BASE_URL?.trim();
  let keyRequired = true;
  if (baseURL) {
    try {
      // Only TypeSafe's hosted API is known to need a key. A self-hosted
      // /v1/systemone server (OpenJev, Ollaya, ...) frequently has none,
      // and insisting on a dummy value would just be friction.
      keyRequired = new URL(baseURL).hostname === HOSTED_BACKEND_HOST;
    } catch {
      problems.push(`TYPESAFE_BASE_URL is not a valid URL: ${baseURL}`);
    }
  }
  if (keyRequired && !env.TYPESAFE_API_KEY?.trim()) {
    problems.push(
      "TYPESAFE_API_KEY is not set: every turn would log classifier-unavailable and the router would never route."
    );
  }
  if (env.ROUTER_MODE === "live" && !env.ROUTER_MAX_TIER?.trim()) {
    problems.push(
      "ROUTER_MODE=live with no ROUTER_MAX_TIER: nothing caps autonomous spend. Set ROUTER_MAX_TIER=opus unless you mean to allow fable."
    );
  }
  return problems;
}

/** Where the classifier is sent, mirroring the SDK's own defaults, so the
 * operator can see at startup whether turns are going to a hosted API or a
 * local model. */
export function describeBackend(env: NodeJS.ProcessEnv): string {
  const baseURL = (env.TYPESAFE_BASE_URL?.trim() || `https://${HOSTED_BACKEND_HOST}`).replace(/\/+$/, "");
  return `${baseURL} (model ${env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-latest"})`;
}

/** Prints every startup problem and returns whether startup must abort.
 * A missing key or an unparseable base URL is fatal: a router that can
 * never classify is useless, whereas a missing spend ceiling is the
 * operator's call. */
export function reportStartupProblems(env: NodeJS.ProcessEnv): boolean {
  const problems = validateStartupConfig(env);
  for (const problem of problems) console.warn(`warning: ${problem}`);
  return problems.some((p) => p.startsWith("TYPESAFE_API_KEY") || p.startsWith("TYPESAFE_BASE_URL"));
}

if (isMainModule(import.meta.url)) {
  if (reportStartupProblems(process.env)) process.exit(1);
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
    console.log(`classifier: ${describeBackend(process.env)}`);
  });
}
