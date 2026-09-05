import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, safeParseConfig } from "../src/config.ts";

test("parseConfig accepts minimal config and fills defaults", () => {
  const cfg = parseConfig({
    model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
  });
  assert.equal(cfg.model.providerID, "anthropic");
  assert.equal(cfg.intent.maxChars, 4000);
  assert.equal(cfg.intent.compactThreshold, 0.8);
  assert.equal(cfg.intent.maxRecentMessages, 20);
  assert.equal(cfg.validate.skip.length, 0);
  assert.equal(cfg.validate.requireApprovalOnMismatch, true);
  assert.equal(cfg.validate.failOpenOnError, true);
  assert.equal(cfg.validate.cacheTtlMs, 30_000);
  assert.equal(cfg.validate.mode, "llm");
  assert.equal(cfg.storage.directory, ".opencode/intent");
  assert.equal(cfg.logging, true);
});

test("parseConfig respects user overrides", () => {
  const cfg = parseConfig({
    model: { providerID: "openai", modelID: "gpt-4o-mini" },
    intent: { maxChars: 2000, compactThreshold: 0.5, maxRecentMessages: 5 },
    validate: {
      tools: ["bash"],
      skip: ["read"],
      requireApprovalOnMismatch: false,
      failOpenOnError: false,
      cacheTtlMs: 1000,
      mode: "heuristic",
    },
    storage: { directory: "/tmp/x" },
    logging: false,
  });
  assert.equal(cfg.intent.maxChars, 2000);
  assert.equal(cfg.validate.tools?.[0], "bash");
  assert.equal(cfg.validate.skip[0], "read");
  assert.equal(cfg.validate.mode, "heuristic");
  assert.equal(cfg.storage.directory, "/tmp/x");
  assert.equal(cfg.logging, false);
});

test("parseConfig rejects missing model", () => {
  assert.throws(() => parseConfig({}));
});

test("safeParseConfig returns ok:false with zod error on bad input", () => {
  const r = safeParseConfig({ model: { providerID: "" } });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.error.issues.length > 0);
  }
});

test("safeParseConfig returns ok:true with valid input", () => {
  const r = safeParseConfig({
    model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
  });
  assert.equal(r.ok, true);
});
