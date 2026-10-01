import { test } from "node:test";
import assert from "node:assert/strict";
import { validateStartupConfig } from "../src/server.js";
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
