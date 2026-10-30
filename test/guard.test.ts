import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runGuard,
  guardToolCall,
  guardCacheKey,
  clearGuardCache,
  type AskFn,
  type GuardInput,
} from "../src/guard.ts";
import { parseConfig } from "../src/config.ts";

const cfg = parseConfig({});

const baseInput: GuardInput = {
  tool: "shell",
  args: { command: "npm test" },
  intentBody: "goal: ship the gate",
  intentVersion: 1,
};

function askWith(scope: string, confidence: number, score: number): { ask: AskFn; calls: unknown[] } {
  const calls: unknown[] = [];
  // Distribution whose expected value equals `score` (0..2): the decision
  // client computes the weighted mean over numeric levels.
  const probabilities =
    score <= 1 ? { "0": 1 - score, "1": score, "2": 0 } : { "0": 0, "1": 2 - score, "2": score - 1 };
  const ask: AskFn = async (args) => {
    calls.push(args);
    return {
      scope: {
        type: "choice",
        choice: scope,
        probabilities:
          scope === "within_scope"
            ? { within_scope: confidence, out_of_scope: 1 - confidence }
            : { within_scope: 1 - confidence, out_of_scope: confidence },
        confidence,
      },
      severity: {
        type: "score",
        score,
        probabilities,
        confidence: 0.5,
      },
    };
  };
  return { ask, calls };
}

test("guard allows when within_scope and confidence >= safeConfidence", async () => {
  const { ask } = askWith("within_scope", 0.9, 0.2);
  const verdict = await runGuard(cfg, baseInput, { ask });
  assert.equal(verdict.safe, true);
  assert.equal(verdict.scope, "within_scope");
  assert.equal(verdict.severity, "low");
  assert.match(
    verdict.reason,
    /^decision: within_scope p=0\.90, confidence 0\.90, severity 0\.2\/2 \(harmless\)$/,
  );
});

test("guard blocks when within_scope but confidence is low (uncertain escalates)", async () => {
  const { ask } = askWith("within_scope", 0.7, 0.2);
  const verdict = await runGuard(cfg, baseInput, { ask });
  assert.equal(verdict.safe, false);
});

test("guard blocks on out_of_scope regardless of confidence", async () => {
  const { ask } = askWith("out_of_scope", 0.95, 0.2);
  const verdict = await runGuard(cfg, baseInput, { ask });
  assert.equal(verdict.safe, false);
  assert.equal(verdict.scope, "out_of_scope");
  assert.match(verdict.reason, /^decision: out_of_scope p=0\.95/);
});

test("guard maps severity score to low/medium/high", async () => {
  for (const [score, severity] of [
    [0.2, "low"],
    [1.2, "medium"],
    [1.9, "high"],
  ] as const) {
    const { ask } = askWith("out_of_scope", 0.9, score);
    const verdict = await runGuard(cfg, baseInput, { ask });
    assert.equal(verdict.severity, severity, `score ${score}`);
  }
});

test("guard sends both questions in one decision call", async () => {
  const { ask, calls } = askWith("within_scope", 0.9, 0);
  await runGuard(cfg, baseInput, { ask });
  const args = calls[0] as { state: string; questions: Record<string, { type: string }> };
  assert.equal(Object.keys(args.questions).length, 2);
  assert.equal(args.questions.scope?.type, "choice");
  assert.equal(args.questions.severity?.type, "score");
  assert.ok(args.state.includes("npm test"));
  assert.ok(args.state.includes("ship the gate"));
});

test("guard cache: identical call is answered once, second is cached", async () => {
  clearGuardCache();
  const { ask, calls } = askWith("within_scope", 0.9, 0);
  const first = await guardToolCall(cfg, baseInput, { ask });
  const second = await guardToolCall(cfg, baseInput, { ask });
  assert.equal(calls.length, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.safe, first.safe);
});

test("guard cache key is stable under args key-order permutations", () => {
  const a = guardCacheKey({ ...baseInput, args: { x: 1, y: 2 } });
  const b = guardCacheKey({ ...baseInput, args: { y: 2, x: 1 } });
  assert.equal(a, b);
  const c = guardCacheKey({ ...baseInput, args: { x: 1, y: 3 } });
  assert.notEqual(a, c);
});

test("guard cache auto-invalidates when the intent version bumps", async () => {
  clearGuardCache();
  const { ask, calls } = askWith("within_scope", 0.9, 0);
  await guardToolCall(cfg, baseInput, { ask });
  await guardToolCall(cfg, { ...baseInput, intentVersion: 2 }, { ask });
  assert.equal(calls.length, 2);
});

test("guard cache expires after cacheTtlMs", async () => {
  clearGuardCache();
  const { ask, calls } = askWith("within_scope", 0.9, 0);
  let now = 1_000_000;
  await guardToolCall(cfg, baseInput, { ask, now: () => now });
  now += cfg.validate.cacheTtlMs + 1;
  await guardToolCall(cfg, baseInput, { ask, now: () => now });
  assert.equal(calls.length, 2);
});

test("guard cache disabled when cacheTtlMs is 0", async () => {
  clearGuardCache();
  const noCache = parseConfig({ validate: { cacheTtlMs: 0 } });
  const { ask, calls } = askWith("within_scope", 0.9, 0);
  await guardToolCall(noCache, baseInput, { ask });
  await guardToolCall(noCache, baseInput, { ask });
  assert.equal(calls.length, 2);
});

test("clearGuardCache drops warm entries", async () => {
  clearGuardCache();
  const { ask, calls } = askWith("within_scope", 0.9, 0);
  await guardToolCall(cfg, baseInput, { ask });
  clearGuardCache();
  await guardToolCall(cfg, baseInput, { ask });
  assert.equal(calls.length, 2);
});
