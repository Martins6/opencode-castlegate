import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIntentValidatePrompt,
  parseIntentValidateResponse,
  summarizeArgs,
} from "../src/prompts/intent-validate.ts";

test("parseIntentValidateResponse accepts plain JSON", () => {
  const result = parseIntentValidateResponse(
    '{"match": true, "reason": "directly advances the goal", "severity": "low"}',
  );
  assert.equal(result.match, true);
  assert.equal(result.reason, "directly advances the goal");
  assert.equal(result.severity, "low");
});

test("parseIntentValidateResponse strips code fences", () => {
  const result = parseIntentValidateResponse(
    '```json\n{"match": false, "reason": "out of scope", "severity": "medium"}\n```',
  );
  assert.equal(result.match, false);
  assert.equal(result.severity, "medium");
});

test("parseIntentValidateResponse handles surrounding prose", () => {
  const result = parseIntentValidateResponse(
    'Here is my decision:\n{"match": false, "reason": "rm is dangerous", "severity": "high"}',
  );
  assert.equal(result.match, false);
  assert.equal(result.severity, "high");
});

test("parseIntentValidateResponse throws on non-JSON", () => {
  assert.throws(() => parseIntentValidateResponse("not json at all"));
});

test("parseIntentValidateResponse throws when match is missing", () => {
  assert.throws(() =>
    parseIntentValidateResponse('{"reason": "x", "severity": "low"}'),
  );
});

test("parseIntentValidateResponse defaults severity to medium on invalid value", () => {
  const result = parseIntentValidateResponse(
    '{"match": true, "reason": "ok", "severity": "bogus"}',
  );
  assert.equal(result.severity, "medium");
});

test("buildIntentValidatePrompt embeds digest and tool", () => {
  const prompt = buildIntentValidatePrompt({
    digest: "refactor auth module",
    tool: "bash",
    argsSummary: '{"command":"rm -rf /tmp/foo"}',
  });
  assert.match(prompt, /refactor auth module/);
  assert.match(prompt, /bash/);
  assert.match(prompt, /rm -rf/);
  assert.match(prompt, /JSON/);
});

test("summarizeArgs truncates long command", () => {
  const long = "a".repeat(2000);
  const out = summarizeArgs("bash", { command: long });
  assert.ok(out.length <= 1300);
  assert.match(out, /\.\.\."/);
});

test("summarizeArgs keeps short values intact", () => {
  assert.equal(summarizeArgs("read", { filePath: "src/x.ts" }), '{"filePath":"src/x.ts"}');
});

test("summarizeArgs handles null args", () => {
  assert.equal(summarizeArgs("bash", null), "(no arguments)");
});
