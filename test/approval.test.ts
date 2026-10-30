import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  absorbClearance,
  blockedCommand,
  canonicalSignature,
  consumeQuestionResult,
  createApprovalStore,
  extractAnswerLabels,
  extractAnswerText,
  isApproval,
  isDenial,
  openBlock,
  transformQuestionInput,
  type PendingBlock,
} from "../src/approval.ts";
import type { IntentChange } from "../src/prompts/intent-update.ts";

function makeBlock(overrides: Partial<PendingBlock> = {}): PendingBlock {
  const block: PendingBlock = {
    blockId: "cb_deadbeef",
    sessionId: "ses_1",
    tool: "shell",
    args: { command: "rm -rf /tmp/scratch" },
    signature: canonicalSignature("shell", { command: "rm -rf /tmp/scratch" }),
    blockedAt: "2026-01-02T03:04:05.000Z",
  };
  return { ...block, ...overrides };
}

// ---------------------------------------------------------------------------
// canonicalSignature
// ---------------------------------------------------------------------------

test("canonicalSignature is stable under key-order permutations", () => {
  const a = canonicalSignature("shell", { command: "ls", cwd: "/tmp", depth: 2 });
  const b = canonicalSignature("shell", { depth: 2, cwd: "/tmp", command: "ls" });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/, "lowercase hex sha256");
});

test("canonicalSignature differs across tools and args", () => {
  const base = canonicalSignature("shell", { command: "ls" });
  assert.notEqual(base, canonicalSignature("edit", { command: "ls" }));
  assert.notEqual(base, canonicalSignature("shell", { command: "ls -la" }));
  assert.notEqual(base, canonicalSignature("shell", { command: "ls", extra: 1 }));
});

test("canonicalSignature matches sha256(tool + NUL + canonicalJSON(args))", () => {
  const args = { b: 2, a: 1 };
  const expected = createHash("sha256")
    .update(`shell\0${JSON.stringify({ a: 1, b: 2 })}`)
    .digest("hex");
  assert.equal(canonicalSignature("shell", args), expected);
});

// ---------------------------------------------------------------------------
// openBlock + store
// ---------------------------------------------------------------------------

test("openBlock formats blockId as cb_ + 8 hex chars and fills fields", () => {
  const block = openBlock({
    sessionId: "ses_2",
    tool: "shell",
    args: { command: "git push" },
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
  });
  assert.match(block.blockId, /^cb_[0-9a-f]{8}$/);
  assert.equal(block.sessionId, "ses_2");
  assert.equal(block.tool, "shell");
  assert.equal(block.signature, canonicalSignature("shell", { command: "git push" }));
  assert.equal(block.blockedAt, new Date(Date.UTC(2026, 0, 2, 3, 4, 5)).toISOString());
  assert.deepEqual(block.args, { command: "git push" });
});

test("openBlock generates distinct blockIds", () => {
  const ids = new Set(
    Array.from({ length: 50 }, () => openBlock({ sessionId: "s", tool: "shell", args: {} }).blockId),
  );
  assert.equal(ids.size, 50);
});

test("store add/get/delete/clear", () => {
  const store = createApprovalStore();
  const block = makeBlock();
  store.add(block);
  assert.equal(store.get(block.blockId), block);
  store.delete(block.blockId);
  assert.equal(store.get(block.blockId), undefined);
  store.add(block);
  store.clear();
  assert.equal(store.get(block.blockId), undefined);
});

test("store findForPrompt matches a prompt carrying the blockId", () => {
  const store = createApprovalStore();
  const block = makeBlock();
  store.add(block);
  const found = store.findForPrompt("ses_1", `Should we proceed? (block ${block.blockId})`);
  assert.equal(found, block);
});

test("store findForPrompt ignores prompts without the blockId and other sessions", () => {
  const store = createApprovalStore();
  const block = makeBlock();
  store.add(block);
  assert.equal(store.findForPrompt("ses_1", "unrelated question about the weather"), undefined);
  assert.equal(store.findForPrompt("ses_other", `block ${block.blockId}`), undefined);
});

// ---------------------------------------------------------------------------
// transformQuestionInput (SPEC §3.5 step 2)
// ---------------------------------------------------------------------------

test("transformQuestionInput appends the exact command line and does not mutate input", () => {
  const block = makeBlock({ args: { command: "rm -rf /tmp/scratch" } });
  const input = { question: `Approve? id=${block.blockId}`, multiple: false };
  const frozen = JSON.parse(JSON.stringify(input));

  const out = transformQuestionInput(input, block) as Record<string, unknown>;

  assert.notEqual(out, input, "returns a new object");
  assert.deepEqual(input, frozen, "input is not mutated");
  assert.equal(
    out["question"],
    `Approve? id=${block.blockId}\n\nBlocked command: \`rm -rf /tmp/scratch\``,
  );
  assert.equal(out["multiple"], false, "other fields are preserved");
});

test("transformQuestionInput falls back to canonicalJSON when args has no command", () => {
  const block = makeBlock({ args: { script: "ls", cwd: "/tmp" } });
  const input = { question: `see ${block.blockId}` };
  const out = transformQuestionInput(input, block) as Record<string, unknown>;
  assert.equal(
    out["question"],
    `see ${block.blockId}\n\nBlocked command: \`${JSON.stringify({ cwd: "/tmp", script: "ls" })}\``,
  );
  assert.equal(blockedCommand(block), JSON.stringify({ cwd: "/tmp", script: "ls" }));
});

test("transformQuestionInput falls back to the first string field carrying the blockId", () => {
  const block = makeBlock();
  const input = { header: `ref ${block.blockId}`, question: "Approve?" };
  const out = transformQuestionInput(input, block) as Record<string, unknown>;
  assert.equal(out["header"], `ref ${block.blockId}\n\nBlocked command: \`rm -rf /tmp/scratch\``);
  assert.equal(out["question"], "Approve?", "question without blockId untouched");
});

test("transformQuestionInput leaves inputs without the blockId untouched", () => {
  const block = makeBlock();
  const input = { question: "What is 2+2?" };
  assert.deepEqual(transformQuestionInput(input, block), input);
  assert.equal(transformQuestionInput("just a string", block), "just a string");
  assert.equal(transformQuestionInput(null, block), null);
});

// ---------------------------------------------------------------------------
// isApproval — FAIL-CLOSED table (SPEC §3.5 step 3)
// ---------------------------------------------------------------------------

test("isApproval is fail-closed: only exactly 'approve' counts", () => {
  const approving = ["approve", "Approve", " approve ", "APPROVE", "Approve\n"];
  const refusing = ["yes", "sure", "approve!", "sure, approve", "approve now", "", "  ", "denied", "ok", "y", "approve it"];
  for (const text of approving) assert.equal(isApproval(text), true, `expected approve: ${JSON.stringify(text)}`);
  for (const text of refusing) assert.equal(isApproval(text), false, `expected refusal: ${JSON.stringify(text)}`);
});

test("isDenial recognises exactly 'deny'", () => {
  assert.equal(isDenial("deny"), true);
  assert.equal(isDenial(" Deny "), true);
  assert.equal(isDenial("no"), false);
  assert.equal(isDenial(""), false);
});

// ---------------------------------------------------------------------------
// extractAnswerText — real Tool.Result shapes (@opencode/schema dist/tool.d.ts)
// ---------------------------------------------------------------------------

test("extractAnswerText concatenates text parts from a content array", () => {
  const result = {
    content: [
      { type: "text", text: "Approve" },
      { type: "file", uri: "file:///x", mime: "text/plain" },
      { type: "text", text: "" },
    ],
  };
  assert.equal(extractAnswerText(result), "Approve\n");
});

test("extractAnswerText handles plain string content, plain strings, and output", () => {
  assert.equal(extractAnswerText({ content: "approve" }), "approve");
  assert.equal(extractAnswerText("approve"), "approve");
  assert.equal(extractAnswerText({ output: "approve" }), "approve");
});

test("extractAnswerText prefers content over output and returns '' for junk", () => {
  assert.equal(extractAnswerText({ content: [{ type: "text", text: "deny" }], output: "approve" }), "deny");
  assert.equal(extractAnswerText({ output: 42 }), "");
  assert.equal(extractAnswerText(null), "");
  assert.equal(extractAnswerText(undefined), "");
  assert.equal(extractAnswerText({ metadata: {} }), "");
});

// ---------------------------------------------------------------------------
// consumeQuestionResult (SPEC §3.5 step 3)
// ---------------------------------------------------------------------------

test("consumeQuestionResult approve path returns the clearance line and consumes the block", () => {
  const store = createApprovalStore();
  const block = makeBlock();
  store.add(block);
  const now = () => Date.UTC(2026, 5, 6, 7, 8, 9);

  const out = consumeQuestionResult(
    store,
    block,
    { content: [{ type: "text", text: "Approve" }] },
    now,
    45,
  );

  assert.deepEqual(out, {
    decision: "approve",
    approvedAt: "2026-06-06T07:08:09.000Z",
    clearanceLine:
      "CASTLEGATE_CLEARANCE: approvedAt 2026-06-06T07:08:09.000Z — the intent absorbs this clearance within 45s.",
  });
  assert.equal(store.get(block.blockId), undefined, "pending block consumed on approval");
});

test("consumeQuestionResult deny path changes nothing", () => {
  const store = createApprovalStore();
  const block = makeBlock();
  store.add(block);

  const out = consumeQuestionResult(store, block, { content: [{ type: "text", text: " Deny " }] });
  assert.deepEqual(out, { decision: "deny" });
  assert.equal(store.get(block.blockId), block, "pending block left alone on denial");
});

test("consumeQuestionResult unmatched path for free text (fail-closed)", () => {
  const store = createApprovalStore();
  const block = makeBlock();
  store.add(block);

  const out = consumeQuestionResult(store, block, { content: [{ type: "text", text: "sure, approve" }] });
  assert.deepEqual(out, { decision: "unmatched" });
  assert.equal(store.get(block.blockId), block);
});

// ---------------------------------------------------------------------------
// Replay journal (SPEC §3.5 step 4, §5.1)
// ---------------------------------------------------------------------------

test("replay clearance expires after ttlMs under the injected clock", () => {
  const store = createApprovalStore();
  const sig = canonicalSignature("shell", { command: "ls" });
  let clock = 1_000_000;
  const now = () => clock;

  assert.equal(store.isReplayCleared(sig, now), false, "never marked");
  store.markReplayCleared(sig, 300_000, now);
  assert.equal(store.isReplayCleared(sig, now), true, "cleared within ttl");

  clock += 299_999;
  assert.equal(store.isReplayCleared(sig, now), true, "still cleared just before expiry");

  clock += 1;
  assert.equal(store.isReplayCleared(sig, now), false, "expired at ttl — dead, not resurrected");
  assert.equal(store.isReplayCleared(sig, () => clock - 1), false, "expired entry is dropped");
});

test("replay journal deleteReplay/clearReplay and signature isolation", () => {
  const store = createApprovalStore();
  const sigA = canonicalSignature("shell", { command: "a" });
  const sigB = canonicalSignature("shell", { command: "b" });
  const now = () => 0;

  store.markReplayCleared(sigA, 1_000, now);
  store.markReplayCleared(sigB, 1_000, now);
  assert.equal(store.isReplayCleared(sigB, now), true);

  store.deleteReplay(sigA);
  assert.equal(store.isReplayCleared(sigA, now), false);
  assert.equal(store.isReplayCleared(sigB, now), true, "other signatures unaffected");

  store.clearReplay();
  assert.equal(store.isReplayCleared(sigB, now), false);
});

test("stores isolate state (factory gives independent instances)", () => {
  const a = createApprovalStore();
  const b = createApprovalStore();
  const block = makeBlock();
  a.add(block);
  a.markReplayCleared(block.signature, 1_000, () => 0);
  assert.equal(b.get(block.blockId), undefined);
  assert.equal(b.isReplayCleared(block.signature, () => 0), false);
});

// ---------------------------------------------------------------------------
// absorbClearance (SPEC §3.5 step 5)
// ---------------------------------------------------------------------------

test("absorbClearance success fires absorb with the clearance change", async () => {
  const block = makeBlock({ args: { command: "rm -rf /tmp/scratch" } });
  const seen: IntentChange[] = [];

  await absorbClearance(
    {
      absorb: async (change) => {
        seen.push(change);
        return "ok";
      },
      replayTtlMs: 300_000,
    },
    block,
    "2026-06-06T07:08:09.000Z",
  );

  assert.deepEqual(seen, [
    {
      type: "clearance",
      command: "rm -rf /tmp/scratch",
      approvedAt: "2026-06-06T07:08:09.000Z",
      blockId: block.blockId,
    },
  ]);
});

test("absorbClearance slow path fires onAbsorbSlow when absorb outlives the TTL", async () => {
  const block = makeBlock();
  const slow: Array<{ durationMs: number; replayTtlMs: number }> = [];
  let clock = 0;
  const now = () => clock;

  await absorbClearance(
    {
      absorb: async () => {
        clock += 300_001; // resolves after replayTtlMs
        return "ok";
      },
      onAbsorbSlow: (info) => slow.push(info),
      replayTtlMs: 300_000,
      now,
    },
    block,
    "2026-06-06T07:08:09.000Z",
  );

  assert.deepEqual(slow, [{ durationMs: 300_001, replayTtlMs: 300_000 }]);
});

test("absorbClearance does not fire onAbsorbSlow within the TTL", async () => {
  const block = makeBlock();
  const slow: unknown[] = [];
  let clock = 0;

  await absorbClearance(
    {
      absorb: async () => {
        clock += 299_999;
        return "ok";
      },
      onAbsorbSlow: (info) => slow.push(info),
      replayTtlMs: 300_000,
      now: () => clock,
    },
    block,
    "2026-06-06T07:08:09.000Z",
  );

  assert.deepEqual(slow, []);
});

test("absorbClearance never throws — errors go to onAbsorbError", async () => {
  const block = makeBlock();
  const boom = new Error("update node down");
  const errors: unknown[] = [];
  const slow: unknown[] = [];

  await absorbClearance(
    {
      absorb: async () => {
        throw boom;
      },
      onAbsorbError: (err) => errors.push(err),
      onAbsorbSlow: (info) => slow.push(info),
      replayTtlMs: 300_000,
    },
    block,
    "2026-06-06T07:08:09.000Z",
  );

  assert.deepEqual(errors, [boom]);
  assert.deepEqual(slow, [], "slow is not reported for failed absorptions");
});

test("absorbClearance swallows the error even without onAbsorbError", async () => {
  const block = makeBlock();
  await absorbClearance(
    {
      absorb: async () => {
        throw new Error("silent");
      },
      replayTtlMs: 300_000,
    },
    block,
    "2026-06-06T07:08:09.000Z",
  );
});

// ---------------------------------------------------------------------------
// Real V2 question shapes (captured from a live TUI session)
// ---------------------------------------------------------------------------

function realQuestionInput(blockId: string) {
  return {
    questions: [
      {
        header: "Approve Block",
        multiple: false,
        options: [
          { label: "Approve", description: `Explicitly approve the block with ID ${blockId}.` },
          { label: "Deny", description: `Deny the block ${blockId}.` },
        ],
        question: `Please approve or deny the block with ID ${blockId}. Select Approve or type exactly 'approve'.`,
      },
    ],
  };
}

test("findForPrompt matches the nested questions[].question shape", () => {
  const store = createApprovalStore();
  const block = openBlock({ sessionId: "s1", tool: "shell", args: { command: "sleep 3" } });
  store.add(block);
  const found = store.findForPrompt("s1", JSON.stringify(realQuestionInput(block.blockId)));
  assert.equal(found?.blockId, block.blockId);
});

test("transformQuestionInput appends into questions[].question, not option descriptions", () => {
  const block = openBlock({ sessionId: "s1", tool: "shell", args: { command: "sleep 3" } });
  const input = realQuestionInput(block.blockId);
  const out = transformQuestionInput(input, block) as ReturnType<typeof realQuestionInput>;
  const first = out.questions[0];
  assert.ok(first);
  assert.match(first.question, /Blocked command: `sleep 3`/);
  assert.doesNotMatch(first.options[0]?.description ?? "", /Blocked command/);
  assert.doesNotMatch(input.questions[0]?.question ?? "", /Blocked command/); // input untouched
});

test("consumeQuestionResult approves on the real rendered answer pair", () => {
  const store = createApprovalStore();
  const block = openBlock({ sessionId: "s1", tool: "shell", args: { command: "sleep 3" } });
  store.add(block);
  const result = {
    content: [
      {
        type: "text",
        text:
          'User has answered your questions: "Please approve or deny the block with ID ' +
          block.blockId +
          '."="Approve"',
      },
    ],
  };
  const out = consumeQuestionResult(
    store,
    block,
    result,
    () => Date.parse("2026-10-30T22:30:00.000Z"),
    60,
  );
  assert.equal(out.decision, "approve");
  if (out.decision === "approve") {
    assert.match(out.clearanceLine, /^CASTLEGATE_CLEARANCE: approvedAt 2026-10-30T22:30:00\.000Z/);
    assert.equal(store.get(block.blockId), undefined); // consumed
  }
});

test("consumeQuestionResult: denial beats approval on mixed labels", () => {
  const store = createApprovalStore();
  const block = openBlock({ sessionId: "s1", tool: "shell", args: { command: "sleep 3" } });
  store.add(block);
  const result = {
    content: [
      { type: "text", text: 'answered: "one"="Approve" "two"="Deny"' },
    ],
  };
  assert.equal(consumeQuestionResult(store, block, result).decision, "deny");
});

test("consumeQuestionResult stays fail-closed on free text without a selected label", () => {
  const store = createApprovalStore();
  const block = openBlock({ sessionId: "s1", tool: "shell", args: { command: "sleep 3" } });
  store.add(block);
  const result = { content: [{ type: "text", text: "I think approve is fine here" }] };
  assert.equal(consumeQuestionResult(store, block, result).decision, "unmatched");
});

test("extractAnswerLabels prefers structured answers, then rendered pairs, then whole text", () => {
  assert.deepEqual(extractAnswerLabels({ answers: ["Approve"] }), ["Approve"]);
  assert.deepEqual(
    extractAnswerLabels({ content: [{ type: "text", text: 'q"="Approve"' }] }),
    ["Approve"],
  );
  assert.deepEqual(extractAnswerLabels({ content: [{ type: "text", text: "approve" }] }), [
    "approve",
  ]);
  assert.deepEqual(extractAnswerLabels({}), []);
});
