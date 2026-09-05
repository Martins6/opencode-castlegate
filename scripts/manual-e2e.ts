#!/usr/bin/env -S node --experimental-strip-types
/**
 * Manual end-to-end smoke for castlegate.
 *
 * Boots a fake opencode plugin input, installs castlegate with a tiny config,
 * and exercises:
 *   1. session.created → digest file appears
 *   2. message.updated → digest update is scheduled (we trigger it manually)
 *   3. tool.execute.before on a bash call → validator runs, falls back (no LLM here)
 *   4. intent_context tool → returns the digest
 *
 * This does NOT contact a real opencode server or LLM. It is purely a wiring check.
 */

import * as path from "node:path";
import * as os from "node:os";
import { promises as fs } from "node:fs";
import { CastlegatePlugin } from "../src/index.ts";

type AppLogEntry = { body: { service: string; level: string; message: string; extra?: unknown } };

function fakeClient(dir: string) {
  const logs: AppLogEntry[] = [];
  const sessionMessages = new Map<string, Array<{ info: { id: string; role: string }; parts: Array<{ type: string; text?: string }> }>>();
  const sidecarSessions = new Map<string, Array<{ role: string; content: string }>>();

  return {
    logs,
    async app_log(entry: AppLogEntry) {
      logs.push(entry);
    },
    async session_create(_body: { title: string }) {
      const id = `sidecar_${Math.random().toString(36).slice(2, 10)}`;
      sidecarSessions.set(id, []);
      return { data: { id, title: _body.title } };
    },
    async session_messages({ path: { id } }: { path: { id: string } }) {
      return { data: sessionMessages.get(id) ?? [] };
    },
    async session_prompt({ path: { id }, body }: { path: { id: string }; body: { parts: Array<{ type: string; text?: string }> } }) {
      const session = sidecarSessions.get(id) ?? [];
      const last = body.parts[0];
      const userText = last?.text ?? "";
      const reply = JSON.stringify({
        digest: `mock digest for: ${userText.slice(0, 40)}`,
        intentShift: "mock",
      });
      session.push({ role: "user", content: userText });
      session.push({ role: "assistant", content: reply });
      return { data: { info: { role: "assistant" as const }, parts: [{ type: "text", text: reply }] } };
    },
  };
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "castlegate-e2e-"));
  const client = fakeClient(dir);
  const cfg = {
    model: { providerID: "mock", modelID: "mock-1" },
    storage: { directory: ".castlegate-test" },
    intent: { maxChars: 4000, compactThreshold: 0.8, maxRecentMessages: 5 },
    validate: {
      skip: [],
      requireApprovalOnMismatch: true,
      failOpenOnError: true,
      cacheTtlMs: 0,
      mode: "llm" as const,
    },
    logging: true,
  };

  const plugin = CastlegatePlugin(
    {
      client: client as unknown as Parameters<typeof CastlegatePlugin>[0]["client"],
      project: { id: "proj1" } as never,
      directory: dir,
      worktree: dir,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost:4096"),
      $: (() => {}) as never,
    },
    cfg,
  );

  const hooks = await plugin;
  console.log("plugin loaded:", Object.keys(hooks));

  await hooks.event!({
    event: { type: "session.created", properties: { info: { id: "sess_x" } } } as never,
  });

  const digestFile = path.join(dir, ".castlegate-test", "sess_x.md");
  const exists = await fs.stat(digestFile).then(() => true).catch(() => false);
  console.log("digest file created:", exists);

  await hooks["tool.execute.before"]!(
    { tool: "bash", sessionID: "sess_x", callID: "c1" } as never,
    { args: { command: "echo hi" } },
  );
  console.log("logs after validation:", client.logs.length);

  if (hooks.tool?.intent_context) {
    const t = hooks.tool.intent_context;
    const result = await t.execute({ format: "summary" }, {
      sessionID: "sess_x",
      messageID: "m1",
      agent: "main",
      directory: dir,
      worktree: dir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    } as never);
    console.log("intent_context tool result:\n", result);
  }

  await hooks.dispose?.();
  await fs.rm(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
