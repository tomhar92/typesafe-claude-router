import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpgradeNoteBlock } from "../src/upgradeNote.js";

test("produces a text content block naming the tier and cost", () => {
  const block = buildUpgradeNoteBlock("opus", 0.0287);
  assert.equal(block.type, "text");
  assert.match(block.text, /opus/);
  assert.match(block.text, /\$0\.0287/);
  assert.match(block.text, /\/model opus/);
});
