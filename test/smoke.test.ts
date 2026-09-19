import { test } from "node:test";
import assert from "node:assert/strict";

test("smoke: test harness runs", () => {
  assert.equal(1 + 1, 2);
});
