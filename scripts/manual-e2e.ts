#!/usr/bin/env node
/**
 * Manual smoke test for the V2 plugin wiring. Contacts no real server or LLM:
 * the decision server (fetch) and generation are stubbed. Run with:
 *
 *   node --experimental-strip-types scripts/manual-e2e.ts
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import castlegate, { setScheduleTestHooks } from "../src/index.ts";
import { isCastlegateError } from "../src/errors.ts";

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "castlegate-e2e-"));
  const previousFetch = globalThis.fetch;
  let decisionMode: "ok" | "down" = "ok";

  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(rawBody) as {
      questions: Record<string, { type: string }>;
    };
    if (decisionMode === "down") throw new Error("connection refused");
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(body.questions)) {
      if (q.type === "noul") answers[name] = { type: "noul", noul: 0.9 };
      else if (q.type === "choice") {
        answers[name] = {
          type: "choice",
          choice: "out_of_scope",
          probabilities: { within_scope: 0.05, out_of_scope: 0.95 },
          confidence: 0.95,
        };
      } else {
        answers[name] = {
          type: "score",
          score: 1.9,
          probabilities: { "0": 0, "1": 0.1, "2": 0.9 },
          confidence: 0.5,
        };
      }
    }
    return new Response(JSON.stringify({ answers }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  setScheduleTestHooks({ debounceMs: 10 });

  const hooks = new Map<string, Array<(event: unknown) => Promise<void> | void>>();
  const tools: Array<{ name: string; execute: (i: unknown, c: unknown) => Promise<unknown> }> = [];
  const messages = [{ id: "m1", type: "user" as const, text: "please ship the gate" }];
  const eventQueue: unknown[] = [];
  const waiters: Array<() => void> = [];

  const ctx = {
    options: {},
    location: { directory: dir },
    generate: {
      text: async ({ prompt }: { prompt: string }) => {
        console.log(`[e2e] generate called (${prompt.length} chars)`);
        return { text: "# Intent\n\n- goal: ship the gate" };
      },
    },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal } = {}) =>
        (async function* () {
          while (!signal?.aborted) {
            if (eventQueue.length > 0) {
              yield eventQueue.shift();
              continue;
            }
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
        })(),
    },
    tool: {
      hook: async (name: string, cb: (event: unknown) => Promise<void> | void) => {
        const list = hooks.get(name) ?? [];
        list.push(cb);
        hooks.set(name, list);
        return { dispose: async () => undefined };
      },
      transform: async (cb: (editor: unknown) => void) => {
        cb({
          add: (tool: { name: string; execute: (i: unknown, c: unknown) => Promise<unknown> }) =>
            tools.push(tool),
          list: () => tools,
          get: () => undefined,
          namespace: () => undefined,
          update: () => undefined,
          remove: () => undefined,
        });
        return { dispose: async () => undefined };
      },
    },
    session: {
      context: async () => messages,
      get: async () => ({ parentID: undefined }),
      synthetic: async ({ sessionID, text }: { sessionID: string; text: string }) => {
        console.log(`[e2e] synthetic to ${sessionID}: ${text.split("\n")[0]}`);
      },
    },
  };

  const emit = (event: unknown) => {
    eventQueue.push(event);
    const w = waiters.shift();
    if (w) w();
  };
  const runHook = async (name: string, event: unknown) => {
    for (const cb of hooks.get(name) ?? []) await cb(event);
  };

  const cleanup = await (castlegate.setup as (c: unknown) => Promise<() => Promise<void>>)(ctx);
  console.log("[e2e] plugin setup ok; tools:", tools.map((t) => t.name).join(", "));

  emit({ type: "session.created", data: { sessionID: "ses_e2e" } });
  emit({ type: "session.inbox.delivered", data: { sessionID: "ses_e2e", inboxID: "m1" } });
  await new Promise((r) => setTimeout(r, 200));

  const intentPath = path.join(dir, ".opencode/intent/ses_e2e.md");
  const raw = await fs.readFile(intentPath, "utf8");
  console.log("[e2e] intent file after update:\n" + raw);

  try {
    await runHook("execute.before", {
      tool: "shell",
      input: { command: "rm -rf build" },
      sessionID: "ses_e2e",
      messageID: "m1",
      id: "c1",
    });
    console.log("[e2e] FAIL: out-of-scope command was allowed");
  } catch (err) {
    console.log("[e2e] guard blocked as expected:", isCastlegateError(err), "-", String(err).split("\n")[0]);
  }

  decisionMode = "down";
  try {
    await runHook("execute.before", {
      tool: "shell",
      input: { command: "ls" },
      sessionID: "ses_e2e",
      messageID: "m1",
      id: "c2",
    });
    console.log("[e2e] FAIL: api-down should have blocked (default onApiUnavailable=block)");
  } catch (err) {
    console.log("[e2e] api-down blocked as expected:", String(err).split("\n")[0]);
  }

  await cleanup();
  globalThis.fetch = previousFetch;
  await fs.rm(dir, { recursive: true, force: true });
  console.log("[e2e] done");
}

main().catch((err) => {
  console.error("[e2e] crashed:", err);
  process.exitCode = 1;
});
