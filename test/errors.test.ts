import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CastlegateIntentMismatchError,
  CastlegateApiUnavailableError,
  CastlegateIntentTooLongError,
  isCastlegateError,
} from "../src/errors.ts";

test("CastlegateIntentMismatchError message matches the SPEC §4.3 template exactly", () => {
  const err = new CastlegateIntentMismatchError({
    tool: "shell",
    reason: "decision: out_of_scope p=0.91, confidence 0.88, severity 2.0/2 (destructive)",
    severity: "high",
    blockedAt: "2026-01-02T03:04:05.000Z",
    blockId: "cb_deadbeef",
    absorbWaitSeconds: 60,
  });

  const expected =
    "CASTLEGATE_INTENT_MISMATCH: tool 'shell' did not match the current session intent.\n" +
    "Reason: decision: out_of_scope p=0.91, confidence 0.88, severity 2.0/2 (destructive)\n" +
    "Severity: high\n" +
    "Blocked at: 2026-01-02T03:04:05.000Z\n" +
    "Block id: cb_deadbeef\n" +
    "Action required: surface this to the user via the question tool with exactly two options: Approve / Deny, including the block id verbatim in the question. Tell the user to pick the Approve option or type exactly 'approve' — any other answer counts as refusal. Only an explicit 'approve' unlocks the command; free text never does.\n" +
    "If the user approves: the clearance is absorbed into the intent within 60s — a CASTLEGATE_CLEARANCE line carrying the approval time is appended to the question result, so you can count elapsed time. Retry the same command immediately; wait 60s before expecting similar commands to pass without asking.\n" +
    "If the user denies: do not retry the tool call.";
  assert.equal(err.message, expected);
  assert.ok(!err.message.endsWith("\n"), "message has no trailing newline");
});

test("CastlegateIntentMismatchError carries tag and all fields", () => {
  const err = new CastlegateIntentMismatchError({
    tool: "shell",
    reason: "out of scope",
    severity: "medium",
    blockedAt: "2026-02-03T04:05:06.000Z",
    blockId: "cb_cafe0123",
    absorbWaitSeconds: 90,
  });
  assert.equal(err.tag, "CASTLEGATE_INTENT_MISMATCH");
  assert.equal(err.tool, "shell");
  assert.equal(err.reason, "out of scope");
  assert.equal(err.severity, "medium");
  assert.equal(err.blockedAt, "2026-02-03T04:05:06.000Z");
  assert.equal(err.blockId, "cb_cafe0123");
  assert.equal(err.absorbWaitSeconds, 90);
  assert.ok(err instanceof Error);
  assert.equal(err.name, "CastlegateIntentMismatchError");
});

test("CastlegateApiUnavailableError message matches the SPEC §4.3 template exactly", () => {
  const err = new CastlegateApiUnavailableError({
    node: "guard",
    baseURL: "http://127.0.0.1:8080/v1/systemone",
    attempts: 3,
  });

  const expected =
    "CASTLEGATE_API_UNAVAILABLE: castlegate cannot reach the guard decision server at http://127.0.0.1:8080/v1/systemone after 3 attempts.\n" +
    "The plugin cannot make safety decisions.\n" +
    'Set "enabled": false or comment out opencode-castlegate in opencode.json until the API is back.';
  assert.equal(err.message, expected);
  assert.ok(!err.message.endsWith("\n"), "message has no trailing newline");

  assert.equal(err.tag, "CASTLEGATE_API_UNAVAILABLE");
  assert.equal(err.node, "guard");
  assert.equal(err.baseURL, "http://127.0.0.1:8080/v1/systemone");
  assert.equal(err.attempts, 3);
  assert.equal(err.name, "CastlegateApiUnavailableError");
});

test("CastlegateApiUnavailableError renders the gate node too", () => {
  const err = new CastlegateApiUnavailableError({
    node: "gate",
    baseURL: "http://localhost:9/v1/systemone",
    attempts: 1,
  });
  assert.ok(
    err.message.startsWith(
      "CASTLEGATE_API_UNAVAILABLE: castlegate cannot reach the gate decision server at http://localhost:9/v1/systemone after 1 attempts.",
    ),
  );
});

test("CastlegateIntentTooLongError message matches the SPEC §4.3 template exactly", () => {
  const err = new CastlegateIntentTooLongError({ maxChars: 10_000, shrinkAttempts: 3 });

  const expected =
    "CASTLEGATE_INTENT_TOO_LONG: intent body exceeded 10000 characters after 3 attempts.\n" +
    "The previous intent was kept unchanged.\n" +
    "Please open an issue at https://github.com/Martins6/opencode-castlegate";
  assert.equal(err.message, expected);
  assert.ok(!err.message.endsWith("\n"), "message has no trailing newline");

  assert.equal(err.tag, "CASTLEGATE_INTENT_TOO_LONG");
  assert.equal(err.maxChars, 10_000);
  assert.equal(err.shrinkAttempts, 3);
  assert.equal(err.name, "CastlegateIntentTooLongError");
});

test("isCastlegateError recognises direct instances", () => {
  assert.equal(
    isCastlegateError(
      new CastlegateIntentMismatchError({
        tool: "shell",
        reason: "r",
        severity: "low",
        blockedAt: "2026-01-01T00:00:00.000Z",
        blockId: "cb_00000000",
        absorbWaitSeconds: 60,
      }),
    ),
    true,
  );
  assert.equal(
    isCastlegateError(
      new CastlegateApiUnavailableError({ node: "gate", baseURL: "http://x", attempts: 0 }),
    ),
    true,
  );
  assert.equal(isCastlegateError(new CastlegateIntentTooLongError({ maxChars: 1, shrinkAttempts: 1 })), true);
});

test("isCastlegateError recognises plain objects carrying a tag (cross-realm copies)", () => {
  assert.equal(isCastlegateError({ tag: "CASTLEGATE_INTENT_MISMATCH" }), true);
  assert.equal(isCastlegateError({ tag: "CASTLEGATE_API_UNAVAILABLE", baseURL: "http://x" }), true);
  assert.equal(isCastlegateError({ tag: "CASTLEGATE_INTENT_TOO_LONG" }), true);
});

test("isCastlegateError rejects unrelated values (fail-closed)", () => {
  assert.equal(isCastlegateError(new Error("CASTLEGATE_INTENT_MISMATCH: not really tagged")), false);
  assert.equal(isCastlegateError(new Error("nope")), false);
  assert.equal(isCastlegateError({ message: "CASTLEGATE_API_UNAVAILABLE: x" }), false);
  assert.equal(isCastlegateError({ tag: "OTHER_TAG" }), false);
  assert.equal(isCastlegateError({ tag: 42 }), false);
  assert.equal(isCastlegateError("CASTLEGATE_INTENT_MISMATCH"), false);
  assert.equal(isCastlegateError(null), false);
  assert.equal(isCastlegateError(undefined), false);
  assert.equal(isCastlegateError(42), false);
});
