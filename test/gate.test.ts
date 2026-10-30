import { test } from "node:test";
import assert from "node:assert/strict";
import { runGate, type AskFn } from "../src/gate.ts";
import { buildDecisionState } from "../src/state.ts";
import { parseConfig } from "../src/config.ts";

const cfg = parseConfig({});

function askWith(noul: number): { ask: AskFn; calls: unknown[] } {
  const calls: unknown[] = [];
  const ask: AskFn = async (args) => {
    calls.push(args);
    return { intent_change: { type: "noul", noul } };
  };
  return { ask, calls };
}

test("gate votes update with no intent yet, without asking the model", async () => {
  const ask: AskFn = async () => {
    assert.fail("ask must not be called when no intent exists");
  };
  const result = await runGate(cfg, { currentIntent: "", userText: "ship the feature" }, { ask });
  assert.equal(result.update, true);
  assert.equal(result.probability, 1);
  assert.match(result.reason, /no intent/);
});

test("gate updates when P(update) >= gateThreshold", async () => {
  const { ask, calls } = askWith(0.9);
  const result = await runGate(cfg, { currentIntent: "ship the gate", userText: "also add tests" }, { ask });
  assert.equal(result.update, true);
  assert.equal(result.probability, 0.9);
  assert.match(result.reason, /^gate: P\(update\)=0\.90 threshold=0\.5$/);
  assert.equal(calls.length, 1);
});

test("gate skips when P(update) is below threshold", async () => {
  const { ask } = askWith(0.1);
  const result = await runGate(cfg, { currentIntent: "ship the gate", userText: "hmm" }, { ask });
  assert.equal(result.update, false);
  assert.equal(result.probability, 0.1);
});

test("gate treats the threshold as inclusive", async () => {
  const { ask } = askWith(cfg.decision.gateThreshold);
  const result = await runGate(cfg, { currentIntent: "x", userText: "y" }, { ask });
  assert.equal(result.update, true);
});

test("gate sends the intent and the user text as state", async () => {
  const { ask, calls } = askWith(0.5);
  await runGate(cfg, { currentIntent: "ANCHOR GOAL", userText: "NEW USER TEXT" }, { ask });
  const args = calls[0] as { state: string; questions: Record<string, { type: string }> };
  assert.ok(args.state.includes("ANCHOR GOAL"));
  assert.ok(args.state.includes("NEW USER TEXT"));
  assert.equal(args.questions.intent_change?.type, "noul");
});

test("buildDecisionState passes through when it fits", () => {
  const state = buildDecisionState("goal: ship it\n- 2026-10-30 — user approved `rm x` (clearance cb_1)", "Proposed call: rm y", 1000);
  assert.ok(state.includes("goal: ship it"));
  assert.ok(state.includes("user approved `rm x`"));
  assert.ok(state.includes("Proposed call: rm y"));
  assert.ok(state.length <= 1000);
});

test("buildDecisionState keeps clearances and the command when trimming", () => {
  const intent = [
    "goal: ship it",
    "detail: " + "x".repeat(500),
    "- 2026-10-30 — user approved `rm -rf node_modules` (clearance cb_ab12)",
  ].join("\n");
  const state = buildDecisionState(intent, "Proposed shell call: {\"command\":\"rm -rf node_modules\"}", 300);
  assert.ok(state.length <= 300);
  assert.ok(state.includes("user approved `rm -rf node_modules`"), "clearance must survive trimming");
  assert.ok(state.includes("rm -rf node_modules\"}"), "the proposed command must survive trimming");
  assert.ok(state.includes("goal: ship it"), "anchor (head) must survive trimming");
});

test("buildDecisionState never exceeds the budget even with huge extras", () => {
  const state = buildDecisionState("tiny", "z".repeat(10_000), 500);
  assert.ok(state.length <= 500);
});
