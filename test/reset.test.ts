import { test } from "node:test";
import assert from "node:assert/strict";
import { detectReset } from "../src/reset.js";

test("detects reset on the very first turn (no prior messages)", () => {
  assert.equal(detectReset(undefined, [{ role: "user", content: "hi" }]), true);
  assert.equal(detectReset([], [{ role: "user", content: "hi" }]), true);
});

test("detects reset when history got shorter (compact/clear)", () => {
  const last = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];
  const current = [{ role: "user", content: "summary" }];
  assert.equal(detectReset(last, current), true);
});

test("detects reset when the tracked prefix no longer matches", () => {
  const last = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
  const current = [
    { role: "user", content: "a-but-different" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];
  assert.equal(detectReset(last, current), true);
});

test("does not flag a normal append-only turn as a reset", () => {
  const last = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
  const current = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];
  assert.equal(detectReset(last, current), false);
});
