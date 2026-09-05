import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildIntentUpdatePrompt,
  parseIntentUpdateResponse,
  enforceMaxChars,
} from "../src/prompts/intent-update.ts";

test("parseIntentUpdateResponse accepts plain JSON", () => {
  const out = parseIntentUpdateResponse(
    '{"digest": "- ship the gate", "intentShift": "user clarified scope"}',
  );
  assert.equal(out.digest, "- ship the gate");
  assert.equal(out.intentShift, "user clarified scope");
});

test("parseIntentUpdateResponse accepts fenced JSON", () => {
  const out = parseIntentUpdateResponse('```json\n{"digest":"x","intentShift":""}\n```');
  assert.equal(out.digest, "x");
});

test("parseIntentUpdateResponse throws when digest missing", () => {
  assert.throws(() => parseIntentUpdateResponse('{"intentShift":""}'));
});

test("enforceMaxChars truncates to limit", () => {
  assert.equal(enforceMaxChars("abcdef", 3), "abc");
  assert.equal(enforceMaxChars("abc", 3), "abc");
  assert.equal(enforceMaxChars("abc", 0), "abc");
});

test("buildIntentUpdatePrompt includes anchor framing when compact=true", () => {
  const prompt = buildIntentUpdatePrompt({
    previousDigest: "old summary",
    maxChars: 2000,
    newMessages: [{ role: "user", text: "also clean tests" }],
    compact: true,
  });
  assert.match(prompt, /ANCHOR INTENT/);
  assert.match(prompt, /2000/);
  assert.match(prompt, /REPLACE/);
});

test("buildIntentUpdatePrompt says MERGE when compact=false", () => {
  const prompt = buildIntentUpdatePrompt({
    previousDigest: "",
    maxChars: 1000,
    newMessages: [],
    compact: false,
  });
  assert.match(prompt, /MERGES/);
  assert.match(prompt, /\(no prior digest/);
});
