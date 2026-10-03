import { choice, TypeSafeClient, type JsonValue } from "@typesafe-ai/sdk";

/** The one question the router asks; backends key their answer on it. */
const QUESTION = "tier";

export interface ClassifierRequest {
  state: { recentMessages: JsonValue[]; latestUserMessage: string };
  instructions: string;
  criteria: Record<string, string>;
}

/** What a backend hands back, deliberately untrusted: `confidence` and
 * `probabilities` are optional on some wire formats, and `choice` is just
 * a string. `classifyTurn` validates all of it against the real tier set,
 * so an adapter only has to translate, never to vouch for the answer. */
export interface RawChoiceAnswer {
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface ChooseOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/** A decision-model transport. The deadline and abort signal are the
 * backend's to honour, because only it can cancel the underlying request;
 * wrapping a slow call in a timeout that cancels nothing is what PR 7
 * removed. */
export interface ClassifierBackend {
  choose(request: ClassifierRequest, options: ChooseOptions): Promise<RawChoiceAnswer>;
}

let sharedClient: TypeSafeClient | undefined;

/** TypeSafe's SDK. Also reaches any server that speaks `/v1/systemone`
 * (set TYPESAFE_BASE_URL / TYPESAFE_DEFAULT_MODEL), since the SDK owns
 * those variables. */
export function sdkBackend(client?: Pick<TypeSafeClient, "systemOne">): ClassifierBackend {
  return {
    async choose(request, { timeoutMs, signal }) {
      const target = client ?? (sharedClient ??= new TypeSafeClient());
      const { answers } = await target.systemOne(
        {
          state: request.state,
          questions: { [QUESTION]: choice(request.instructions, request.criteria) },
        },
        // The SDK owns the deadline: no retries, one short timeout. A
        // routing decision is only useful for the turn it was made for.
        { timeout: timeoutMs, retry: { maxRetries: 0 }, signal }
      );
      const answer = answers[QUESTION];
      return {
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: { ...answer.probabilities },
      };
    },
  };
}

/** Combines the caller's signal with a deadline into one signal, and
 * returns the cleanup that must run once the request has settled so the
 * timer and listener do not outlive it. */
function withDeadline(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("classifier_timeout")), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export interface OpenRouterBackendOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  /** Injection point for tests. */
  fetch?: typeof fetch;
}

/** OpenRouter's alpha Decisions endpoint. Its question objects are the same
 * `{ type, instructions, criteria }` shape the TypeSafe SDK sends; what
 * differs is the path, and that `confidence` and `probabilities` are
 * optional in its response schema. */
export function openRouterBackend(options: OpenRouterBackendOptions): ClassifierBackend {
  const { apiKey, model, baseURL = DEFAULT_OPENROUTER_BASE_URL, fetch: fetchImpl = fetch } = options;
  const url = `${baseURL.replace(/\/+$/, "")}/api/alpha/decisions`;
  return {
    async choose(request, { timeoutMs, signal }) {
      const deadline = withDeadline(signal, timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            state: request.state,
            questions: {
              [QUESTION]: {
                type: "choice",
                instructions: request.instructions,
                criteria: request.criteria,
              },
            },
          }),
          signal: deadline.signal,
        });
        if (!response.ok) throw new Error(`openrouter decisions request failed: ${response.status}`);
        const body = (await response.json()) as { answers?: Record<string, any> };
        const answer = body?.answers?.[QUESTION];
        if (answer?.type !== "choice" || typeof answer.choice !== "string") {
          throw new Error("openrouter returned a malformed choice answer");
        }
        return {
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: answer.probabilities,
        };
      } finally {
        deadline.cleanup();
      }
    },
  };
}

const BACKEND_NAMES = ["typesafe", "openrouter"];

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai";
export const DEFAULT_OPENROUTER_MODEL = "~typesafe/jev-latest";

/** Which backend the environment selects (unvalidated). */
export function backendName(env: NodeJS.ProcessEnv): string {
  return env.ROUTER_CLASSIFIER?.trim() || "typesafe";
}

/** Problems with the classifier-backend settings, for the startup check to
 * report before the first turn instead of as a silent per-turn failure. */
export function validateBackendConfig(env: NodeJS.ProcessEnv): string[] {
  const name = backendName(env);
  if (!BACKEND_NAMES.includes(name)) {
    return [`ROUTER_CLASSIFIER=${name} is not a known backend (expected one of: ${BACKEND_NAMES.join(", ")}).`];
  }
  if (name === "openrouter" && !env.OPENROUTER_API_KEY?.trim()) {
    return ["ROUTER_CLASSIFIER=openrouter but OPENROUTER_API_KEY is not set."];
  }
  return [];
}

/** Builds the backend the environment asks for. Throws on a bad
 * configuration; `classifyTurn` catches that into `classifier-unavailable`,
 * which is why startup validation exists. */
export function backendFromEnv(env: NodeJS.ProcessEnv): ClassifierBackend {
  const problems = validateBackendConfig(env);
  if (problems.length > 0) throw new Error(problems[0]);
  if (backendName(env) === "openrouter") {
    return openRouterBackend({
      apiKey: env.OPENROUTER_API_KEY!.trim(),
      model: env.ROUTER_CLASSIFIER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL,
      baseURL: env.OPENROUTER_BASE_URL?.trim() || undefined,
    });
  }
  return sdkBackend();
}
