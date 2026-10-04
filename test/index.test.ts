import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CastlegatePlugin } from "../src/index.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("digest updates are coalesced while in flight and sidecar is deleted on dispose", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "castlegate-index-test-"));
  const messages = [
    {
      info: { id: "message_1", role: "user", sessionID: "session_1" },
      parts: [{ type: "text", text: "Inspect the workspace." }],
    },
  ];
  const logMessages: string[] = [];
  const deletedSessions: string[] = [];
  let promptCalls = 0;
  let activePrompts = 0;
  let maxActivePrompts = 0;
  let disposed = false;
  let releaseFirstPrompt!: () => void;
  let signalPromptStarted!: () => void;
  const firstPromptGate = new Promise<void>((resolve) => {
    releaseFirstPrompt = resolve;
  });
  const promptStarted = new Promise<void>((resolve) => {
    signalPromptStarted = resolve;
  });

  const client = {
    app: {
      log: async ({ body }: { body: { message: string } }) => {
        logMessages.push(body.message);
        return { data: {} };
      },
    },
    session: {
      create: async () => ({ data: { id: "sidecar_1" } }),
      messages: async () => ({ data: messages }),
      prompt: async () => {
        promptCalls += 1;
        activePrompts += 1;
        maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
        if (promptCalls === 1) {
          signalPromptStarted();
          await firstPromptGate;
        }
        activePrompts -= 1;
        return {
          data: {
            parts: [{
              type: "text",
              text: JSON.stringify({ digest: "Inspect the workspace.", intentShift: "" }),
            }],
          },
        };
      },
      delete: async ({ path: sessionPath }: { path: { id: string } }) => {
        deletedSessions.push(sessionPath.id);
        return { data: true };
      },
    },
  };

  const hooks = await CastlegatePlugin(
    {
      client: client as never,
      project: { id: "project_1" } as never,
      directory,
      worktree: directory,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost:4096"),
      $: (() => {}) as never,
    },
    {
      model: { providerID: "mock", modelID: "mock-1" },
      intent: { maxChars: 1000, compactThreshold: 0.8, maxRecentMessages: 5 },
      validate: {
        tools: ["bash"],
        skip: [],
        requireApprovalOnMismatch: true,
        failOpenOnError: true,
        cacheTtlMs: 0,
        mode: "llm",
      },
      storage: { directory: path.join(directory, "intent") },
      logging: true,
    },
  );

  try {
    await hooks.event!({
      event: { type: "session.created", properties: { info: { id: "session_1" } } } as never,
    });
    await hooks.event!({
      event: {
        type: "message.updated",
        properties: { info: { id: "message_1", sessionID: "session_1" } },
      } as never,
    });

    await Promise.race([
      promptStarted,
      delay(3000).then(() => {
        throw new Error("digest prompt did not start");
      }),
    ]);

    // Simulate a burst of message-part deltas while the sidecar request is
    // still pending. They should coalesce into at most one follow-up update.
    for (let i = 0; i < 20; i++) {
      await hooks.event!({
        event: {
          type: "message.part.updated",
          properties: { sessionID: "session_1" },
        } as never,
      });
      await delay(60);
    }
    await delay(1100);

    assert.equal(promptCalls, 1, "part-update burst must not start parallel prompts");
    assert.equal(maxActivePrompts, 1, "only one sidecar prompt may be in flight");

    releaseFirstPrompt();
    await delay(1200);

    assert.equal(promptCalls, 1, "follow-up with no fresh messages should be skipped");
    assert.ok(logMessages.includes("intent.updated"));

    await hooks.dispose?.();
    disposed = true;
    assert.deepEqual(deletedSessions, ["sidecar_1"]);
  } finally {
    releaseFirstPrompt();
    if (!disposed) await hooks.dispose?.();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
