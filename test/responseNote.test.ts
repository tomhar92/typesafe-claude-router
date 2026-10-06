import { test } from "node:test";
import assert from "node:assert/strict";
import { SseNoteInjector, injectNoteIntoJson } from "../src/responseNote.js";

const ev = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function stream(stopReason: string, blocks = 1): string {
  let out = ev("message_start", { message: { usage: { input_tokens: 5 } } });
  for (let i = 0; i < blocks; i++) {
    out += ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
    out += ev("content_block_delta", { index: i, delta: { type: "text_delta", text: `part ${i}` } });
    out += ev("content_block_stop", { index: i });
  }
  out += ev("message_delta", { delta: { stop_reason: stopReason }, usage: { output_tokens: 9 } });
  out += ev("message_stop", {});
  return out;
}

function events(raw: string) {
  return raw
    .split("\n\n")
    .filter(Boolean)
    .map((e) => JSON.parse(e.split("\n").find((l) => l.startsWith("data:"))!.slice(5)));
}

test("adds a text block after the last content block, before message_delta", () => {
  const injector = new SseNoteInjector("NOTE");
  const out = injector.push(stream("end_turn", 2)) + injector.flush();
  const types = events(out).map((e) => `${e.type}${e.index === undefined ? "" : ":" + e.index}`);
  assert.deepEqual(types, [
    "message_start",
    "content_block_start:0", "content_block_delta:0", "content_block_stop:0",
    "content_block_start:1", "content_block_delta:1", "content_block_stop:1",
    "content_block_start:2", "content_block_delta:2", "content_block_stop:2",
    "message_delta",
    "message_stop",
  ]);
  assert.equal(events(out)[8].delta.text, "NOTE");
});

test("passes everything else through byte for byte", () => {
  const input = stream("end_turn");
  const out = new SseNoteInjector("NOTE").push(input);
  const original = input.slice(0, input.indexOf("event: message_delta"));
  assert.ok(out.startsWith(original));
  assert.ok(out.endsWith(input.slice(input.indexOf("event: message_delta"))));
});

test("a reply that stops for a tool call is left alone", () => {
  const input = stream("tool_use");
  const injector = new SseNoteInjector("NOTE");
  assert.equal(injector.push(input) + injector.flush(), input);
});

test("works when events are split across arbitrary chunk boundaries", () => {
  const input = stream("end_turn");
  const whole = new SseNoteInjector("NOTE").push(input);
  const injector = new SseNoteInjector("NOTE");
  let out = "";
  for (let i = 0; i < input.length; i += 7) out += injector.push(input.slice(i, i + 7));
  assert.equal(out + injector.flush(), whole);
});

test("injects at most once", () => {
  const injector = new SseNoteInjector("NOTE");
  const out = injector.push(stream("end_turn") + stream("end_turn"));
  assert.equal(events(out).filter((e) => e.delta?.text === "NOTE").length, 1);
});

test("an unparseable event is relayed as is", () => {
  const injector = new SseNoteInjector("NOTE");
  assert.equal(injector.push("event: ping\ndata: {oops\n\n"), "event: ping\ndata: {oops\n\n");
});

test("JSON body: appends a text block on end_turn only", () => {
  const body = JSON.stringify({ content: [{ type: "text", text: "a" }], stop_reason: "end_turn" });
  assert.equal(JSON.parse(injectNoteIntoJson(body, "NOTE")).content[1].text, "NOTE");
  const tool = JSON.stringify({ content: [{ type: "tool_use" }], stop_reason: "tool_use" });
  assert.equal(injectNoteIntoJson(tool, "NOTE"), tool);
  assert.equal(injectNoteIntoJson("not json", "NOTE"), "not json");
});
