import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, safeParseConfig } from "../src/config.ts";

test("parseConfig accepts empty config and fills spec defaults", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.decision.baseURL, "http://127.0.0.1:8080/v1/systemone");
  assert.equal(cfg.decision.model, "LiquidAI/d1-omni-600M-GGUF:Q8_0");
  assert.equal(cfg.decision.timeoutMs, 10_000);
  assert.equal(cfg.decision.stateMaxChars, 8000);
  assert.equal(cfg.decision.gateThreshold, 0.5);
  assert.equal(cfg.decision.safeConfidence, 0.85);
  assert.equal(cfg.update.model, null);
  assert.equal(cfg.update.timeoutMs, 60_000);
  assert.equal(cfg.approval.absorbWaitSeconds, 60);
  assert.equal(cfg.approval.replayTtlMs, 300_000);
  assert.equal(cfg.intent.maxChars, 10_000);
  assert.equal(cfg.intent.shrinkAttempts, 3);
  assert.equal(cfg.intent.maxRecentMessages, 20);
  assert.deepEqual(cfg.validate.tools, ["shell"]);
  assert.deepEqual(cfg.validate.skip, []);
  assert.equal(cfg.validate.requireApprovalOnMismatch, true);
  assert.equal(cfg.validate.onApiUnavailable, "block");
  assert.equal(cfg.validate.cacheTtlMs, 30_000);
  assert.equal(cfg.retries, 2);
  assert.equal(cfg.storage.directory, ".opencode/intent");
  assert.equal(cfg.logging, true);
});

test("parseConfig respects user overrides", () => {
  const cfg = parseConfig({
    enabled: false,
    decision: {
      baseURL: "http://10.0.0.5:9999/v1/systemone",
      model: "some/other-decision-model",
      timeoutMs: 5000,
      stateMaxChars: 4000,
      gateThreshold: 0.7,
      safeConfidence: 0.9,
    },
    update: { model: "anthropic/claude-haiku-4-5", timeoutMs: 30_000 },
    approval: { absorbWaitSeconds: 30, replayTtlMs: 60_000 },
    intent: { maxChars: 2000, shrinkAttempts: 5, maxRecentMessages: 10 },
    validate: {
      tools: ["shell", "edit"],
      skip: ["read"],
      requireApprovalOnMismatch: false,
      onApiUnavailable: "allow",
      cacheTtlMs: 1000,
    },
    retries: 0,
    storage: { directory: "/tmp/x" },
    logging: false,
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.decision.baseURL, "http://10.0.0.5:9999/v1/systemone");
  assert.equal(cfg.decision.gateThreshold, 0.7);
  assert.equal(cfg.update.model, "anthropic/claude-haiku-4-5");
  assert.equal(cfg.approval.absorbWaitSeconds, 30);
  assert.equal(cfg.intent.maxChars, 2000);
  assert.deepEqual(cfg.validate.tools, ["shell", "edit"]);
  assert.deepEqual(cfg.validate.skip, ["read"]);
  assert.equal(cfg.validate.onApiUnavailable, "allow");
  assert.equal(cfg.retries, 0);
  assert.equal(cfg.storage.directory, "/tmp/x");
  assert.equal(cfg.logging, false);
});

test("parseConfig fills nested defaults for partially-specified sections", () => {
  const cfg = parseConfig({ decision: { gateThreshold: 0.8 } });
  assert.equal(cfg.decision.gateThreshold, 0.8);
  assert.equal(cfg.decision.baseURL, "http://127.0.0.1:8080/v1/systemone");
  assert.equal(cfg.update.model, null);
});

test("safeParseConfig returns ok:false with zod error on bad input", () => {
  const r = safeParseConfig({
    decision: { stateMaxChars: -1 },
    validate: { onApiUnavailable: "maybe" },
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.error.issues.length > 0);
  }
});

test("safeParseConfig returns ok:true with valid input", () => {
  const r = safeParseConfig({ intent: { maxChars: 500 } });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.config.intent.maxChars, 500);
});

test("parseConfig rejects a non-object root", () => {
  assert.throws(() => parseConfig("nope"));
});
