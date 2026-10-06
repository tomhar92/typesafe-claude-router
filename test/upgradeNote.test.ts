import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpgradeNoticeText } from "../src/upgradeNote.js";

test("names the tier, the one-time cost and the command to switch", () => {
  const text = buildUpgradeNoticeText("opus", 0.5412);
  assert.match(text, /opus/);
  assert.match(text, /\$0\.54/);
  assert.match(text, /\/model opus/);
});

test("reads as the router speaking, not the model", () => {
  assert.match(buildUpgradeNoticeText("sonnet", 0.1), /Router note/);
});
