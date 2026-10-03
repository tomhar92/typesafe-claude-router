import { test } from "node:test";
import assert from "node:assert/strict";
import { validateStartupConfig, describeBackend, reportStartupProblems } from "../src/server.js";
import { run } from "../bin/router.js";

test("refuses to start silently without a TypeSafe key", () => {
  const problems = validateStartupConfig({});
  assert.equal(problems.length >= 1, true);
  assert.match(problems[0], /TYPESAFE_API_KEY/);
});

test("treats a blank TypeSafe key as missing", () => {
  assert.match(validateStartupConfig({ TYPESAFE_API_KEY: "  " })[0], /TYPESAFE_API_KEY/);
});

test("warns when live mode runs with no ceiling on spend", () => {
  const problems = validateStartupConfig({ TYPESAFE_API_KEY: "k", ROUTER_MODE: "live" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ROUTER_MAX_TIER/);
});

test("is quiet on a complete configuration", () => {
  assert.deepEqual(
    validateStartupConfig({ TYPESAFE_API_KEY: "k", ROUTER_MODE: "live", ROUTER_MAX_TIER: "opus" }),
    []
  );
});

test("is quiet in shadow mode with a key and no tier ceiling", () => {
  assert.deepEqual(validateStartupConfig({ TYPESAFE_API_KEY: "k" }), []);
});

test("run points the child at a live proxy and returns its exit code", async () => {
  const probe = `
    const url = process.env.ANTHROPIC_BASE_URL;
    if (!/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(url)) process.exit(2);
    fetch(url + "/healthz").then(() => process.exit(0), () => process.exit(3));
  `;
  // Exit 0 means the base URL was set and something was listening on it;
  // any HTTP response at all (even a 4xx/5xx from the unrouted path) counts.
  assert.equal(await run([process.execPath, "-e", probe]), 0);
});

test("run propagates a non-zero exit code from the child", async () => {
  assert.equal(await run([process.execPath, "-e", "process.exit(7)"]), 7);
});

test("run with no command is a usage error", async () => {
  assert.equal(await run([]), 1);
});

test("does not demand a key for a self-hosted /v1/systemone endpoint", () => {
  assert.deepEqual(validateStartupConfig({ TYPESAFE_BASE_URL: "http://localhost:8000" }), []);
});

test("still demands a key when the base URL is TypeSafe's hosted API", () => {
  const problems = validateStartupConfig({ TYPESAFE_BASE_URL: "https://api.typesafe.ai/" });
  assert.match(problems[0], /TYPESAFE_API_KEY/);
});

test("treats an unparseable base URL as a problem rather than guessing", () => {
  const problems = validateStartupConfig({ TYPESAFE_API_KEY: "k", TYPESAFE_BASE_URL: "not a url" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /TYPESAFE_BASE_URL/);
});

test("describeBackend names the endpoint and model in use", () => {
  assert.equal(
    describeBackend({ TYPESAFE_BASE_URL: "http://localhost:8000", TYPESAFE_DEFAULT_MODEL: "openjev-4b" }),
    "http://localhost:8000 (model openjev-4b)"
  );
  assert.equal(describeBackend({}), "https://api.typesafe.ai (model jev-latest)");
});

test("openrouter backend: needs OPENROUTER_API_KEY, not TYPESAFE_API_KEY", () => {
  assert.deepEqual(
    validateStartupConfig({ ROUTER_CLASSIFIER: "openrouter", OPENROUTER_API_KEY: "k" }),
    []
  );
  const problems = validateStartupConfig({ ROUTER_CLASSIFIER: "openrouter" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /OPENROUTER_API_KEY/);
});

test("an unknown ROUTER_CLASSIFIER is reported", () => {
  const problems = validateStartupConfig({ TYPESAFE_API_KEY: "k", ROUTER_CLASSIFIER: "nope" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ROUTER_CLASSIFIER/);
});

test("reportStartupProblems aborts on a bad backend config but not on the spend warning", () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    assert.equal(reportStartupProblems({ ROUTER_CLASSIFIER: "openrouter" }), true);
    assert.equal(reportStartupProblems({ ROUTER_CLASSIFIER: "nope", TYPESAFE_API_KEY: "k" }), true);
    assert.equal(reportStartupProblems({ TYPESAFE_API_KEY: "k", ROUTER_MODE: "live" }), false);
  } finally {
    console.warn = quiet;
  }
});

test("describeBackend names OpenRouter and its model", () => {
  assert.equal(
    describeBackend({ ROUTER_CLASSIFIER: "openrouter" }),
    "https://openrouter.ai (model ~typesafe/jev-latest)"
  );
  assert.equal(
    describeBackend({ ROUTER_CLASSIFIER: "openrouter", ROUTER_CLASSIFIER_MODEL: "typesafe/jev-1.13" }),
    "https://openrouter.ai (model typesafe/jev-1.13)"
  );
});
