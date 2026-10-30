import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import castlegate, { setScheduleTestHooks } from "../src/index.ts";
import { isCastlegateError } from "../src/errors.ts";
import { resetDecisionState } from "../src/decision.ts";

// ── Fake V2 ctx ──────────────────────────────────────────────────────────

interface FakeOptions {
  directory: string;
  options?: Record<string, unknown>;
  messages?: Array<{ id: string; type: "user"; text: string }>;
  parentID?: string;
  generateText?: string;
  decision?: { noul?: number; scope?: string; confidence?: number; score?: number };
  fetchMode?: "ok" | "down" | "bad-request";
}

function makeFakeCtx(opts: FakeOptions) {
  const eventQueue: unknown[] = [];
  const waiters: Array<() => void> = [];
  const hooks = new Map<string, Array<(event: unknown) => Promise<void> | void>>();
  const tools: Array<{ name: string; execute: (input: unknown, context: unknown) => Promise<unknown> }> = [];
  const synthetic: Array<{ sessionID: string; text: string }> = [];
  const generateCalls: string[] = [];

  const messages = [...(opts.messages ?? [])];
  const decision = {
    noul: opts.decision?.noul ?? 0.9,
    scope: opts.decision?.scope ?? "within_scope",
    confidence: opts.decision?.confidence ?? 0.95,
    score: opts.decision?.score ?? 0,
  };

  const previousFetch = globalThis.fetch;
  resetDecisionState();
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    if (!url.includes("/v1/systemone")) return new Response("not found", { status: 404 });
    if (opts.fetchMode === "down") throw new Error("connection refused");
    if (opts.fetchMode === "bad-request") {
      return new Response(JSON.stringify({ error: "prompt too long" }), { status: 400 });
    }
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(rawBody) as {
      questions: Record<string, { type: string }>;
    };
    const answers: Record<string, unknown> = {};
    for (const [name, q] of Object.entries(body.questions)) {
      if (q.type === "noul") answers[name] = { type: "noul", noul: decision.noul };
      else if (q.type === "choice") {
        answers[name] = {
          type: "choice",
          choice: decision.scope,
          probabilities:
            decision.scope === "within_scope"
              ? { within_scope: decision.confidence, out_of_scope: 1 - decision.confidence }
              : { within_scope: 1 - decision.confidence, out_of_scope: decision.confidence },
          confidence: decision.confidence,
        };
      } else {
        const s = decision.score;
        answers[name] = {
          type: "score",
          score: s,
          probabilities: s <= 1 ? { "0": 1 - s, "1": s, "2": 0 } : { "0": 0, "1": 2 - s, "2": s - 1 },
          confidence: 0.5,
        };
      }
    }
    return new Response(JSON.stringify({ answers }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const ctx = {
    options: opts.options ?? {},
    location: { directory: opts.directory },
    generate: {
      text: async ({ prompt }: { prompt: string }) => {
        generateCalls.push(prompt);
        return { text: opts.generateText ?? "# Intent\n\n- goal: test goal" };
      },
    },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal } = {}) => {
        const push = () => {
          const w = waiters.shift();
          if (w) w();
        };
        signal?.addEventListener("abort", push);
        return (async function* () {
          while (true) {
            if (signal?.aborted) return;
            if (eventQueue.length > 0) {
              yield eventQueue.shift();
              continue;
            }
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
        })();
      },
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
          add: (tool: { name: string; execute: (input: unknown, context: unknown) => Promise<unknown> }) =>
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
      get: async () => ({ parentID: opts.parentID }),
      synthetic: async (input: { sessionID: string; text: string }) => {
        synthetic.push(input);
      },
    },
  };

  return {
    ctx,
    hooks,
    tools,
    synthetic,
    generateCalls,
    messages,
    emit(event: unknown) {
      eventQueue.push(event);
      const w = waiters.shift();
      if (w) w();
    },
    async runHook(name: string, event: unknown) {
      for (const cb of hooks.get(name) ?? []) await cb(event);
    },
    restore() {
      globalThis.fetch = previousFetch;
    },
  };
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "castlegate-index-"));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("session.created seeds the intent file", async () => {
  setScheduleTestHooks({ debounceMs: 5 });
  const dir = await tmpDir();
  const fake = makeFakeCtx({ directory: dir });
  const cleanup = await (castlegate.setup as (c: unknown) => Promise<() => Promise<void>>)(fake.ctx);

  fake.emit({ type: "session.created", data: { sessionID: "ses_1" } });
  await new Promise((r) => setTimeout(r, 50));

  const raw = await fs.readFile(path.join(dir, ".opencode/intent/ses_1.md"), "utf8");
  assert.match(raw, /intentVersion: 1/);
  await cleanup();
  fake.restore();
});

test("new user message runs gate -> update and saves the intent", async () => {
  setScheduleTestHooks({ debounceMs: 5 });
  const dir = await tmpDir();
  const fake = makeFakeCtx({
    directory: dir,
    generateText: "# Intent\n\n- goal: ship the gate",
    decision: { noul: 0.9 },
  });
  const cleanup = await (castlegate.setup as (c: unknown) => Promise<() => Promise<void>>)(fake.ctx);

  fake.messages.push({ id: "m1", type: "user", text: "please ship the gate" });
  fake.emit({ type: "session.created", data: { sessionID: "ses_g" } });
  fake.emit({ type: "session.inbox.delivered", data: { sessionID: "ses_g", inboxID: "m1" } });

  await waitFor(() => fake.generateCalls.length > 0);
  await new Promise((r) => setTimeout(r, 50));

  const raw = await fs.readFile(path.join(dir, ".opencode/intent/ses_g.md"), "utf8");
  assert.match(raw, /ship the gate/);
  assert.match(raw, /intentVersion: 2/); // seeded v1 + update v2
  await cleanup();
  fake.restore();
});

test("gate skip leaves the intent untouched", async () => {
  setScheduleTestHooks({ debounceMs: 5 });
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, ".opencode/intent"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".opencode/intent/ses_skip.md"),
    "---\nintentVersion: 1\nlastMessageId: null\nupdatedAt: 2026-10-30T00:00:00.000Z\ncharCount: 20\n---\ngoal: existing goal",
    "utf8",
  );
  const fake = makeFakeCtx({
    directory: dir,
    generateText: "# Intent\n\n- goal: never written",
    decision: { noul: 0.1 },
  });
  const cleanup = await (castlegate.setup as (c: unknown) => Promise<() => Promise<void>>)(fake.ctx);

  fake.messages.push({ id: "m1", type: "user", text: "hm" });
  fake.emit({ type: "session.created", data: { sessionID: "ses_skip" } });
  fake.emit({ type: "session.inbox.delivered", data: { sessionID: "ses_skip", inboxID: "m1" } });
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(fake.generateCalls.length, 0);
  const raw = await fs.readFile(path.join(dir, ".opencode/intent/ses_skip.md"), "utf8");
  assert.doesNotMatch(raw, /never written/);
  await cleanup();
  fake.restore();
});

test("guard blocks an out-of-scope command with the tagged error", async () => {
  setScheduleTestHooks({ debounceMs: 5 });
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, ".opencode/intent"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".opencode/intent/ses_b.md"),
    "---\nintentVersion: 1\nlastMessageId: null\nupdatedAt: 2026-10-30T00:00:00.000Z\ncharCount: 20\n---\ngoal: ship the gate",
    "utf8",
  );
  const fake = makeFakeCtx({ directory: dir, decision: { scope: "out_of_scope", confidence: 0.95, score: 1.9 } });
  const cleanup = await (castlegate.setup as (c: unknown) => Promise<() => Promise<void>>)(fake.ctx);

  const event = { tool: "shell", input: { command: "rm -rf /" }, sessionID: "ses_b", messageID: "m", id: "c1" };
  await assert.rejects(
    () => fake.runHook("execute.before", event),
    (err: unknown) => {
      assert.ok(isCastlegateError(err));
      assert.match(msg(err), /CASTLEGATE_INTENT_MISMATCH: tool 'shell'/);
      assert.match(msg(err), /Block id: cb_/);
      assert.match(msg(err), /Approve \/ Deny/);
      return true;
    },
  );
  await cleanup();
  fake.restore();
});

test("guard allows an in-scope command without prompting", async () => {
  setScheduleTestHooks({ debounceMs: 5 });
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, ".opencode/intent"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".opencode/intent/ses_a.md"),
    "---\nintentVersion: 1\nlastMessageId: null\nupdatedAt: 2026-10-30T00:00:00.000Z\ncharCount: 20\n---\ngoal: ship the gate",
    "utf8",
  );
  const fake = makeFakeCtx({ directory: dir, decision: { scope: "within_scope", confidence: 0.95 } });
  const cleanup = await (castlegate.setup as (c: unknown) => Promise<() => Promise<void>>)(fake.ctx);

  await fake.runHook("execute.before", {
    tool: "shell",
    input: { command: "npm test" },
    sessionID: "ses_a",
    messageID: "m",
    id: "c1",
  });
  await cleanup();
  fake.restore();
});

test("approval flow: question transforms, clearance lands, replay allows", async () => {
  setScheduleTestHooks({ debounceMs: 5 });
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, ".opencode/intent"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".opencode/intent/ses_q.md"),
    "---\nintentVersion: 1\nlastMessageId: null\nupdatedAt: 2026-10-30T00:00:00.000Z\ncharCount: 20\n---\ngoal: ship the gate",
    "utf8",
  );
  const fake = makeFakeCtx({
    directory: dir,
    generateText: "# Intent\n\n- goal: ship the gate\n\n## Approved clearances\n- 2026-10-30 — user approved `npm run db:reset` (clearance cb_x)",
    decision: { scope: "out_of_scope", confidence: 0.95, score: 1 },
  });
  const cleanup = await (castlegate.setup as (c: unknown) => Promise<() => Promise<void>>)(fake.ctx);

  // 1. Block → tagged error with a blockId.
  const shellEvent = {
    tool: "shell",
    input: { command: "npm run db:reset" },
    sessionID: "ses_q",
    messageID: "m",
    id: "c1",
  };
  let blockId = "";
  await fake.runHook("execute.before", shellEvent).catch((err: unknown) => {
    assert.ok(isCastlegateError(err));
    blockId = (/Block id: (\S+)/.exec(msg(err)) ?? [])[1] ?? "";
  });
  assert.match(blockId, /^cb_/);

  // 2. The question prompt gets the exact blocked command injected.
  const questionInput = { question: `May I run this? (${blockId})`, options: ["Approve", "Deny"] };
  const qEvent = { tool: "question", input: questionInput, sessionID: "ses_q", messageID: "m", id: "c2" };
  await fake.runHook("execute.before", qEvent);
  const transformed = (qEvent as { input: { question?: string } }).input;
  assert.match(String(transformed.question ?? ""), /Blocked command: `npm run db:reset`/);

  // 3. Approval → clearance line appended to the result.
  const questionResult = { content: [{ type: "text", text: "approve" }] };
  const afterEvent = {
    tool: "question",
    input: questionInput,
    sessionID: "ses_q",
    messageID: "m",
    id: "c2",
    status: "completed",
    result: questionResult,
  };
  await fake.runHook("execute.after", afterEvent);
  const result = (afterEvent as { result: { content: Array<{ text: string }> } }).result;
  const joined = result.content.map((c) => c.text).join("\n");
  assert.match(joined, /CASTLEGATE_CLEARANCE: approvedAt \S+ — the intent absorbs this clearance within 60s\./);

  // 4. The identical command now passes without a guard call (replay).
  const fetchCountBefore = fake.generateCalls.length;
  await fake.runHook("execute.before", {
    tool: "shell",
    input: { command: "npm run db:reset" },
    sessionID: "ses_q",
    messageID: "m",
    id: "c3",
  });
  assert.equal(fake.generateCalls.length, fetchCountBefore);

  // 5. Absorption folds the clearance into the intent.
  await new Promise((r) => setTimeout(r, 100));
  const raw = await fs.readFile(path.join(dir, ".opencode/intent/ses_q.md"), "utf8");
  assert.match(raw, /Approved clearances/);
  await cleanup();
  fake.restore();
});

test("unrelated question answers never touch guard state", async () => {
  setScheduleTestHooks({ debounceMs: 5 });
  const dir = await tmpDir();
  const fake = makeFakeCtx({ directory: dir });
  const cleanup = await (castlegate.setup as (c: unknown) => Promise<() => Promise<void>>)(fake.ctx);

  const afterEvent = {
    tool: "question",
    input: { question: "Which theme do you prefer?" },
    sessionID: "ses_u",
    messageID: "m",
    id: "c1",
    status: "completed",
    result: { content: [{ type: "text", text: "approve" }] },
  };
  await fake.runHook("execute.after", afterEvent);
  const result = (afterEvent as { result: { content: Array<{ text: string }> } }).result;
  assert.equal(result.content.length, 1); // nothing appended
  await cleanup();
  fake.restore();
});

test("onApiUnavailable=allow lets calls through when the server is down", async () => {
  setScheduleTestHooks({ debounceMs: 5 });
  const dir = await tmpDir();
  await fs.mkdir(path.join(dir, ".opencode/intent"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".opencode/intent/ses_d.md"),
    "---\nintentVersion: 1\nlastMessageId: null\nupdatedAt: 2026-10-30T00:00:00.000Z\ncharCount: 20\n---\ngoal: ship the gate",
    "utf8",
  );
  const fake = makeFakeCtx({
    directory: dir,
    fetchMode: "down",
    options: { validate: { onApiUnavailable: "allow" } },
  });
  const cleanup = await (castlegate.setup as (c: unknown) => Promise<() => Promise<void>>)(fake.ctx);

  await fake.runHook("execute.before", {
    tool: "shell",
    input: { command: "ls" },
    sessionID: "ses_d",
    messageID: "m",
    id: "c1",
  }); // must not throw
  await cleanup();
  fake.restore();
});

test("session.deleted removes the intent file", async () => {
  setScheduleTestHooks({ debounceMs: 5 });
  const dir = await tmpDir();
  const fake = makeFakeCtx({ directory: dir });
  const cleanup = await (castlegate.setup as (c: unknown) => Promise<() => Promise<void>>)(fake.ctx);

  fake.emit({ type: "session.created", data: { sessionID: "ses_del" } });
  await new Promise((r) => setTimeout(r, 50));
  fake.emit({ type: "session.deleted", data: { sessionID: "ses_del" } });
  await new Promise((r) => setTimeout(r, 50));

  await assert.rejects(
    fs.readFile(path.join(dir, ".opencode/intent/ses_del.md"), "utf8"),
    (err: NodeJS.ErrnoException) => err.code === "ENOENT",
  );
  await cleanup();
  fake.restore();
});
