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

test("does not flag a moved cache_control breakpoint as a reset", () => {
  // Claude Code moves the ephemeral cache_control marker onto the newest
  // block it wants cached each turn - the same logical messages otherwise
  // unchanged. A raw byte-for-byte compare used to flag this as a reset on
  // nearly every turn, which defeats the sticky/break-even policy (it
  // always saw "reset" and adopted the raw classifier choice).
  const last = [
    {
      role: "user",
      content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }],
    },
    { role: "assistant", content: [{ type: "text", text: "b" }] },
  ];
  const current = [
    { role: "user", content: [{ type: "text", text: "a" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "b", cache_control: { type: "ephemeral" } }],
    },
    { role: "user", content: "c" },
  ];
  assert.equal(detectReset(last, current), false);
});

test("still flags a real content change even when cache_control also differs", () => {
  const last = [
    {
      role: "user",
      content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }],
    },
    { role: "assistant", content: "b" },
  ];
  const current = [
    { role: "user", content: [{ type: "text", text: "a-but-edited" }] },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];
  assert.equal(detectReset(last, current), true);
});
