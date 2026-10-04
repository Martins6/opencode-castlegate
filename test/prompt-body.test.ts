import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSidecarPromptBody } from "../src/prompt-body.ts";
import { parseConfig } from "../src/config.ts";

test("buildSidecarPromptBody includes model when configured", () => {
  const cfg = parseConfig({
    model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
  });
  const body = buildSidecarPromptBody(cfg, "hello");
  assert.deepEqual(body.model, { providerID: "anthropic", modelID: "claude-haiku-4-5" });
  assert.equal(body.system.length > 0, true);
  assert.deepEqual(body.parts, [{ type: "text", text: "hello" }]);
});

test("buildSidecarPromptBody omits model when unset (zero-config)", () => {
  const cfg = parseConfig({});
  const body = buildSidecarPromptBody(cfg, "hello");
  assert.equal(body.model, undefined);
  assert.equal("model" in body, false);
  assert.deepEqual(body.parts, [{ type: "text", text: "hello" }]);
});