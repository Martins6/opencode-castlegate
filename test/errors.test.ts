import { test } from "node:test";
import assert from "node:assert/strict";
import { CastlegateIntentMismatchError, CASTLEGATE_TAG, CastlegateIntentMismatchError as Renamed } from "../src/errors.ts";

test("error class tags message with CASTLEGATE_INTENT_MISMATCH", () => {
  const err = new CastlegateIntentMismatchError("bash", "out of scope", "high");
  assert.ok(err.message.startsWith(`${CASTLEGATE_TAG}:`));
  assert.equal(err.tool, "bash");
  assert.equal(err.severity, "high");
  assert.match(err.message, /question tool/);
});

test("isMismatch recognises direct throws", () => {
  const err = new CastlegateIntentMismatchError("edit", "x", "low");
  assert.equal(CastlegateIntentMismatchError.isMismatch(err), true);
});

test("isMismatch recognises thrown Error copies", () => {
  const plain = new Error(`${CASTLEGATE_TAG}: something else`);
  assert.equal(CastlegateIntentMismatchError.isMismatch(plain), true);
});

test("isMismatch rejects unrelated errors", () => {
  assert.equal(CastlegateIntentMismatchError.isMismatch(new Error("nope")), false);
  assert.equal(CastlegateIntentMismatchError.isMismatch("a string"), false);
  assert.equal(CastlegateIntentMismatchError.isMismatch(null), false);
});

test("class is re-exportable under another name", () => {
  assert.equal(typeof Renamed, "function");
});
