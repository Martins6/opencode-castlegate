import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runIntentUpdate, type IntentUpdateDeps } from "../src/update.ts";
import { parseConfig } from "../src/config.ts";
import { loadIntent, saveIntent, deleteIntent } from "../src/store.ts";
import type { IntentChange } from "../src/prompts/intent-update.ts";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "castlegate-update-"));
}

const MESSAGE_CHANGE: IntentChange = {
  type: "messages",
  messages: [{ id: "msg_1", text: "ship the gate" }],
};

function depsWith(
  dir: string,
  generate: IntentUpdateDeps["generate"],
  intent: { maxChars: number; shrinkAttempts: number; maxRecentMessages?: number },
): IntentUpdateDeps {
  const config = parseConfig({ intent });
  return { generate, dir, config };
}

test("happy path: saves the generated intent and bumps the version", async () => {
  const dir = await tmpDir();
  const prompts: string[] = [];
  const deps = depsWith(
    dir,
    async (prompt) => {
      prompts.push(prompt);
      return "- goal: ship the gate";
    },
    { maxChars: 1000, shrinkAttempts: 3, maxRecentMessages: 20 },
  );

  const result = await runIntentUpdate(deps, {
    sessionId: "s1",
    change: MESSAGE_CHANGE,
    expectedVersion: 0,
    lastMessageId: "msg_1",
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.header.intentVersion, 1);
    assert.equal(result.header.lastMessageId, "msg_1");
    assert.equal(result.header.charCount, "- goal: ship the gate".length);
  }
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /no intent document yet/);

  const file = await loadIntent(dir, "s1");
  assert.ok(file);
  assert.equal(file.body, "- goal: ship the gate");
  assert.equal(file.header.intentVersion, 1);
});

test("happy path: builds the prompt from the CURRENT on-disk intent", async () => {
  const dir = await tmpDir();
  await saveIntent(dir, "s1", "- goal: old anchor", { expectedVersion: 0 });
  const prompts: string[] = [];
  const deps = depsWith(
    dir,
    async (prompt) => {
      prompts.push(prompt);
      return "- goal: old anchor\n- goal: new addition";
    },
    { maxChars: 1000, shrinkAttempts: 3, maxRecentMessages: 20 },
  );

  const result = await runIntentUpdate(deps, {
    sessionId: "s1",
    change: MESSAGE_CHANGE,
    expectedVersion: 1,
  });

  assert.equal(result.ok, true);
  assert.match(prompts[0] ?? "", /# Current intent\n- goal: old anchor/);
});

test("shrink loop: succeeds on the 2nd attempt with the shrink prompt", async () => {
  const dir = await tmpDir();
  const prompts: string[] = [];
  const oversize = "x".repeat(60);
  let call = 0;
  const deps = depsWith(
    dir,
    async (prompt) => {
      prompts.push(prompt);
      call++;
      return call === 1 ? oversize : "- short body";
    },
    { maxChars: 50, shrinkAttempts: 3, maxRecentMessages: 20 },
  );

  const result = await runIntentUpdate(deps, {
    sessionId: "s1",
    change: MESSAGE_CHANGE,
    expectedVersion: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /Make it smaller, you've passed the 50 limit\./);
  assert.match(prompts[1] ?? "", /x{60}/); // the oversize draft is included

  const file = await loadIntent(dir, "s1");
  assert.equal(file?.body, "- short body");
});

test("shrink loop exhaustion: returns too_long, saves nothing, keeps the previous intent", async () => {
  const dir = await tmpDir();
  await saveIntent(dir, "s1", "previous intent", { expectedVersion: 0 });
  let calls = 0;
  const deps = depsWith(
    dir,
    async () => {
      calls++;
      return "y".repeat(100);
    },
    { maxChars: 30, shrinkAttempts: 2, maxRecentMessages: 20 },
  );

  const result = await runIntentUpdate(deps, {
    sessionId: "s1",
    change: MESSAGE_CHANGE,
    expectedVersion: 1,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "too_long");
  assert.equal(calls, 2); // exactly shrinkAttempts generations

  const file = await loadIntent(dir, "s1");
  assert.ok(file);
  assert.equal(file.body, "previous intent");
  assert.equal(file.header.intentVersion, 1); // no bump
});

test("CAS conflict: re-runs exactly once against the fresh version and succeeds", async () => {
  const dir = await tmpDir();
  await saveIntent(dir, "s1", "- v1", { expectedVersion: 0 });
  let calls = 0;
  const deps = depsWith(
    dir,
    async () => {
      calls++;
      return "- fresh draft";
    },
    { maxChars: 1000, shrinkAttempts: 3, maxRecentMessages: 20 },
  );

  // Caller read version 0 but the file has moved on to 1 → stale draft must
  // not clobber; the whole update re-runs against version 1.
  const result = await runIntentUpdate(deps, {
    sessionId: "s1",
    change: MESSAGE_CHANGE,
    expectedVersion: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(calls, 2); // exactly one re-run
  if (result.ok) assert.equal(result.header.intentVersion, 2);

  const file = await loadIntent(dir, "s1");
  assert.equal(file?.body, "- fresh draft");
  assert.equal(file?.header.intentVersion, 2);
});

test("CAS conflict twice: returns version_conflict and never clobbers", async () => {
  const dir = await tmpDir();
  let calls = 0;
  const deps = depsWith(
    dir,
    async () => {
      calls++;
      // A racer bumps the version between every load and save.
      const current = await loadIntent(dir, "s1");
      await saveIntent(dir, "s1", `interferer-${calls}`, {
        expectedVersion: current?.header.intentVersion ?? 0,
      });
      return `draft-${calls}`;
    },
    { maxChars: 1000, shrinkAttempts: 3, maxRecentMessages: 20 },
  );

  const result = await runIntentUpdate(deps, {
    sessionId: "s1",
    change: MESSAGE_CHANGE,
    expectedVersion: 0,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "version_conflict");
  assert.equal(calls, 2); // one retry only

  const file = await loadIntent(dir, "s1");
  assert.equal(file?.body, "interferer-2"); // the racer wins; drafts discarded
  assert.equal(file?.header.intentVersion, 2);
});

test("tombstoned session: propagates tombstoned and writes nothing", async () => {
  const dir = await tmpDir();
  await saveIntent(dir, "s1", "- v1", { expectedVersion: 0 });
  await deleteIntent(dir, "s1");
  let calls = 0;
  const deps = depsWith(
    dir,
    async () => {
      calls++;
      return "- draft for a dead session";
    },
    { maxChars: 1000, shrinkAttempts: 3, maxRecentMessages: 20 },
  );

  const result = await runIntentUpdate(deps, {
    sessionId: "s1",
    change: MESSAGE_CHANGE,
    expectedVersion: 0,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "tombstoned");
  assert.equal(calls, 1);
  assert.equal(await loadIntent(dir, "s1"), null);
});

test("generate error: returns generate_error with the message, does not throw", async () => {
  const dir = await tmpDir();
  const deps = depsWith(
    dir,
    async () => {
      throw new Error("model exploded");
    },
    { maxChars: 1000, shrinkAttempts: 3, maxRecentMessages: 20 },
  );

  const result = await runIntentUpdate(deps, {
    sessionId: "s1",
    change: MESSAGE_CHANGE,
    expectedVersion: 0,
  });

  assert.equal(result.ok, false);
  if (!result.ok && result.reason === "generate_error") {
    assert.equal(result.message, "model exploded");
  }
  assert.equal(await loadIntent(dir, "s1"), null); // nothing saved
});
