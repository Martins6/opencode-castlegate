/**
 * castlegate — OpenCode V2 plugin entry (SPEC §4.1, §6).
 *
 * Gates `shell` tool calls against a per-session intent maintained by a
 * three-node pipeline (gate/update/guard) with a d1 decision server and
 * OpenCode's own generation. Approval absorption follows SPEC §3.5.
 */

import { Plugin } from "@opencode/plugin";
import { safeParseConfig, type CastlegateConfig } from "./config.ts";
import {
  loadIntent,
  saveIntent,
  deleteIntent,
  reviveIntent,
  resolveStorageDir,
} from "./store.ts";
import { runGate } from "./gate.ts";
import { guardToolCall, clearGuardCache } from "./guard.ts";
import { runIntentUpdate } from "./update.ts";
import type { IntentChange } from "./prompts/intent-update.ts";
import {
  CastlegateIntentMismatchError,
  CastlegateApiUnavailableError,
  CastlegateIntentTooLongError,
  isCastlegateError,
} from "./errors.ts";
import {
  createApprovalStore,
  openBlock,
  blockedCommand,
  transformQuestionInput,
  consumeQuestionResult,
  absorbClearance,
  canonicalSignature,
} from "./approval.ts";
import { DecisionApiUnavailableError, DecisionRequestError, healthCheck } from "./decision.ts";
import { createLogger, redactedArgKeys, type Logger } from "./log.ts";
import { createIntentContextTool } from "./tools/intent-context.ts";

/** Test hook: shrink the 1s debounce in unit tests. */
let debounceMs = 1000;
export function setScheduleTestHooks(hooks: { debounceMs?: number }): void {
  if (hooks.debounceMs !== undefined) debounceMs = hooks.debounceMs;
}

interface SessionState {
  queue: IntentChange[];
  debounce: ReturnType<typeof setTimeout> | undefined;
  inFlight: boolean;
  /** messageID -> user text (source for edit/removal oldText, SPEC §3.2 revocations). */
  userTexts: Map<string, string>;
}

function parseModelRef(ref: string): { providerID: string; id: string } {
  const idx = ref.indexOf("/");
  return idx === -1
    ? { providerID: ref, id: ref }
    : { providerID: ref.slice(0, idx), id: ref.slice(idx + 1) };
}

function questionText(input: unknown): string {
  // The real question tool nests the prompt at `questions: [{ question, ... }]`;
  // collect every string in the tree so the blockId match cannot miss it.
  if (typeof input === "string") return input;
  const parts: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 4) return;
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const value of Object.values(node as Record<string, unknown>)) walk(value, depth + 1);
    }
  };
  walk(input, 0);
  return parts.join("\n");
}

function asArgs(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function appendClearanceLine(result: unknown, line: string): unknown {
  if (!result || typeof result !== "object") return result;
  const rec = { ...(result as Record<string, unknown>) };
  if (typeof rec.content === "string") rec.content = `${rec.content}\n${line}`;
  else if (Array.isArray(rec.content)) rec.content = [...rec.content, { type: "text", text: line }];
  else if (typeof rec.output === "string") rec.output = `${rec.output}\n${line}`;
  else rec.content = line;
  return rec;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default Plugin.define({
  id: "opencode-castlegate",
  async setup(ctx) {
    const parsed = safeParseConfig(ctx.options);
    if (!parsed.ok) {
      console.error(
        JSON.stringify({
          service: "castlegate",
          level: "error",
          event: "config.invalid",
          issues: parsed.error.issues,
        }),
      );
      return () => {};
    }
    const cfg: CastlegateConfig = parsed.config;
    if (!cfg.enabled) return () => {};

    const log: Logger = createLogger(cfg);
    const dir = resolveStorageDir(ctx.location.directory, cfg.storage.directory);
    const store = createApprovalStore();
    const states = new Map<string, SessionState>();
    const abort = new AbortController();

    const state = (sessionID: string): SessionState => {
      let st = states.get(sessionID);
      if (!st) {
        st = { queue: [], debounce: undefined, inFlight: false, userTexts: new Map() };
        states.set(sessionID, st);
      }
      return st;
    };

    // Update node generation: OpenCode's own model (SPEC §1 — no external API).
    const generate = async (prompt: string): Promise<string> => {
      const model = cfg.update.model ? parseModelRef(cfg.update.model) : undefined;
      const call = ctx.generate.text({ prompt, ...(model ? { model } : {}) });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`update generation timed out after ${cfg.update.timeoutMs}ms`)),
          cfg.update.timeoutMs,
        );
      });
      try {
        const result = await Promise.race([call, timeout]);
        return result.text;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const runUpdate = async (sessionID: string, change: IntentChange): Promise<void> => {
      const current = await loadIntent(dir, sessionID);
      const result = await runIntentUpdate(
        { generate, dir, config: cfg },
        {
          sessionId: sessionID,
          change,
          expectedVersion: current?.header.intentVersion ?? 0,
          lastMessageId: null,
        },
      );
      if (result.ok) {
        await log.event("intent.updated", {
          sessionID,
          version: result.header.intentVersion,
          notes: result.notes,
        });
        return;
      }
      if (result.reason === "too_long") {
        await log.event("intent.too_long", { sessionID });
        try {
          await ctx.session.synthetic({
            sessionID,
            text: new CastlegateIntentTooLongError({
              maxChars: cfg.intent.maxChars,
              shrinkAttempts: cfg.intent.shrinkAttempts,
            }).message,
          });
        } catch (err) {
          await log.error("intent.synthetic_error", { sessionID, error: errMsg(err) });
        }
        return;
      }
      await log.event("intent.update_error", { sessionID, reason: result.reason });
    };

    // Debounce 1s + in-flight coalescing (SPEC §6): queued changes wait for a
    // running update and are drained afterwards, never dropped.
    const scheduleUpdate = (sessionID: string, change: IntentChange): void => {
      const st = state(sessionID);
      const last = st.queue[st.queue.length - 1];
      if (change.type === "messages" && last?.type === "messages") {
        last.messages.push(...change.messages); // coalesce message bursts
      } else {
        st.queue.push(change);
      }
      if (st.debounce) clearTimeout(st.debounce);
      st.debounce = setTimeout(() => {
        st.debounce = undefined;
        void flushSession(sessionID);
      }, debounceMs);
    };

    const flushSession = async (sessionID: string): Promise<void> => {
      const st = state(sessionID);
      if (st.inFlight) return;
      st.inFlight = true;
      try {
        while (st.queue.length > 0) {
          const change = st.queue.shift() as IntentChange;
          try {
            await runPipeline(sessionID, change);
          } catch (err) {
            await log.error("intent.update_error", { sessionID, error: errMsg(err) });
          }
        }
      } finally {
        st.inFlight = false;
      }
    };

    // Gate for new user messages; edit/removal/clearance skip the gate (SPEC §3.2).
    const runPipeline = async (sessionID: string, change: IntentChange): Promise<void> => {
      if (change.type === "messages") {
        const current = await loadIntent(dir, sessionID);
        const gate = await runGate(
          cfg,
          {
            currentIntent: current?.body ?? "",
            userText: change.messages.map((m) => m.text).join("\n\n"),
          },
          { signal: abort.signal },
        );
        await log.event(gate.update ? "gate.update" : "gate.skip", {
          sessionID,
          probability: gate.probability,
          reason: gate.reason,
        });
        if (!gate.update) return;
      }
      await runUpdate(sessionID, change);
    };

    // ── Event pipeline ─────────────────────────────────────────────────
    void (async () => {
      try {
        // 2.1.4 SubscribeOptions has no `types` filter (added later) —
        // subscribe to the stream and filter by event.type in the loop.
        const stream = ctx.event.subscribe({ signal: abort.signal });
        for await (const event of stream) {
          try {
            if (event.type === "session.created") {
              const sessionID = event.data.sessionID;
              reviveIntent(dir, sessionID);
              const existing = await loadIntent(dir, sessionID);
              if (!existing) {
                await saveIntent(dir, sessionID, "", { expectedVersion: 0, lastMessageId: null });
              }
              state(sessionID);
              await log.event("session.created", { sessionID });
            } else if (event.type === "session.deleted") {
              const sessionID = event.data.sessionID;
              const st = states.get(sessionID);
              if (st?.debounce) clearTimeout(st.debounce);
              states.delete(sessionID);
              await deleteIntent(dir, sessionID); // tombstones (SPEC §8)
              await log.event("session.deleted", { sessionID });
            } else if (event.type === "session.inbox.delivered") {
              const sessionID = event.data.sessionID;
              const messages = await ctx.session.context({ sessionID });
              const st = state(sessionID);
              const fresh: Array<{ id: string; text: string }> = [];
              for (const m of messages) {
                if (m.type !== "user" || st.userTexts.has(m.id)) continue;
                st.userTexts.set(m.id, m.text);
                fresh.push({ id: m.id, text: m.text });
              }
              if (fresh.length > 0) {
                scheduleUpdate(sessionID, { type: "messages", messages: fresh });
              }
            } else if (event.type === "session.revert.committed") {
              const sessionID = event.data.sessionID;
              // History rewind: everything not surviving is revoked and must
              // leave the intent (SPEC §3.2 "Revocations are first-class").
              const messages = await ctx.session.context({ sessionID });
              const st = state(sessionID);
              const surviving = new Set(messages.map((m) => m.id));
              const removed = [...st.userTexts.keys()].filter((id) => !surviving.has(id));
              if (st.userTexts.size === 0) {
                // Cold cache: re-derive from the surviving user messages.
                const current = messages
                  .filter((m) => m.type === "user")
                  .map((m) => ({ id: m.id, text: m.text }));
                for (const m of current) st.userTexts.set(m.id, m.text);
                if (current.length > 0) {
                  scheduleUpdate(sessionID, { type: "messages", messages: current });
                }
              }
              for (const id of removed) {
                const oldText = st.userTexts.get(id) ?? "";
                st.userTexts.delete(id);
                scheduleUpdate(sessionID, { type: "removal", messageId: id, oldText });
              }
            }
          } catch (err) {
            await log.error("event.handle_error", { error: errMsg(err) });
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) await log.error("event.stream_error", { error: errMsg(err) });
      }
    })();

    // ── Init-time decision-server health check (SPEC §6) ───────────────
    void healthCheck(cfg, abort.signal)
      .then((ok) => {
        if (!ok) {
          return log.warn("api.unavailable", {
            node: "decision",
            baseURL: cfg.decision.baseURL,
            hint: "start llama-server with the d1 GGUF or set \"enabled\": false",
          });
        }
      })
      .catch((err) => log.error("api.healthcheck_error", { error: errMsg(err) }));

    // ── Tool hooks ─────────────────────────────────────────────────────
    await ctx.tool.hook("execute.before", async (event) => {
      // Question transform: inject the exact blocked command + blockId
      // (the agent is not trusted to quote it, SPEC §3.5 step 2).
      if (event.tool === "question") {
        const block = store.findForPrompt(event.sessionID, questionText(event.input));
        if (block) event.input = transformQuestionInput(event.input, block);
        return;
      }
      if (!cfg.validate.tools.includes(event.tool) || cfg.validate.skip.includes(event.tool)) {
        return;
      }

      const args = asArgs(event.input);
      const signature = canonicalSignature(event.tool, args);
      if (store.isReplayCleared(signature)) {
        await log.event("approval.replay_allow", { sessionID: event.sessionID, tool: event.tool });
        return;
      }

      // Subagents validate against the root session's intent (SPEC §5.7).
      type SessionID = typeof event.sessionID;
      let intentSession: SessionID = event.sessionID;
      let file = await loadIntent(dir, intentSession);
      for (let depth = 0; !file && depth < 8; depth++) {
        let parent: SessionID | undefined;
        try {
          const info = (await ctx.session.get({ sessionID: intentSession })) as unknown as {
            parentID?: SessionID;
          };
          parent = info.parentID;
        } catch {
          break;
        }
        if (!parent) break;
        intentSession = parent;
        file = await loadIntent(dir, intentSession);
      }

      if (!file || file.body.trim() === "") {
        await log.event("validate.skip_no_intent", { sessionID: event.sessionID, tool: event.tool });
        return;
      }

      try {
        const verdict = await guardToolCall(
          cfg,
          {
            tool: event.tool,
            args,
            intentBody: file.body,
            intentVersion: file.header.intentVersion,
          },
          { signal: abort.signal },
        );
        if (verdict.safe) {
          await log.event("guard.allow", {
            sessionID: event.sessionID,
            tool: event.tool,
            argKeys: redactedArgKeys(args),
            reason: verdict.reason,
            cached: verdict.cached,
          });
          return;
        }

        const block = openBlock({
          sessionId: event.sessionID,
          tool: event.tool,
          args,
        });
        store.add(block);
        await log.event("guard.block", {
          sessionID: event.sessionID,
          tool: event.tool,
          blockId: block.blockId,
          reason: verdict.reason,
          severity: verdict.severity,
        });
        throw new CastlegateIntentMismatchError({
          tool: event.tool,
          reason: verdict.reason,
          severity: verdict.severity,
          blockedAt: block.blockedAt,
          blockId: block.blockId,
          absorbWaitSeconds: cfg.approval.absorbWaitSeconds,
        });
      } catch (err) {
        // Order matters: the decision client's errors also carry castlegate
        // tags, so they must be handled before the generic tag rethrow.
        if (err instanceof DecisionRequestError) {
          // SPEC §5.7: a 400 is a config error — never "api unavailable".
          await log.event("api.config_error", {
            sessionID: event.sessionID,
            node: "guard",
            baseURL: cfg.decision.baseURL,
            detail: err.detail,
          });
          if (cfg.validate.onApiUnavailable === "block") {
            throw new CastlegateIntentMismatchError({
              tool: event.tool,
              reason:
                "decision request rejected (HTTP 400): decision.stateMaxChars likely exceeds the server batch (-b/-ub). Fix the castlegate config.",
              severity: "high",
              blockedAt: new Date().toISOString(),
              blockId: "cb_config",
              absorbWaitSeconds: cfg.approval.absorbWaitSeconds,
            });
          }
          return;
        }
        if (err instanceof DecisionApiUnavailableError) {
          await log.event("api.unavailable", {
            sessionID: event.sessionID,
            node: "guard",
            baseURL: cfg.decision.baseURL,
            attempts: err.attempts,
          });
          if (cfg.validate.onApiUnavailable === "block") {
            throw new CastlegateApiUnavailableError({
              node: "guard",
              baseURL: cfg.decision.baseURL,
              attempts: err.attempts,
            });
          }
          return;
        }
        throw err;
      }
    });

    await ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== "question") return;
      const block = store.findForPrompt(event.sessionID, questionText(event.input));
      if (!block) return; // unrelated question — never touches guard state (§5.7)

      const outcome = consumeQuestionResult(
        store,
        block,
        event.status === "completed" ? event.result : event.error,
        Date.now,
        cfg.approval.absorbWaitSeconds,
      );

      if (outcome.decision === "approve") {
        if (event.status === "completed") {
          event.result = appendClearanceLine(event.result, outcome.clearanceLine) as typeof event.result;
        }
        store.markReplayCleared(block.signature, cfg.approval.replayTtlMs);
        await log.event("approval.replay_allow", {
          sessionID: event.sessionID,
          blockId: block.blockId,
          approvedAt: outcome.approvedAt,
        });
        void absorbClearance(
          {
            absorb: async (change) => {
              await runUpdate(event.sessionID, change);
            },
            onAbsorbSlow: (info) =>
              log.event("intent.absorb_slow", {
                sessionID: event.sessionID,
                blockId: block.blockId,
                ...info,
              }),
            onAbsorbError: (err) =>
              log.error("intent.update_error", {
                sessionID: event.sessionID,
                blockId: block.blockId,
                error: errMsg(err),
              }),
            replayTtlMs: cfg.approval.replayTtlMs,
          },
          block,
          outcome.approvedAt,
        );
      } else {
        await log.event(outcome.decision === "deny" ? "guard.block" : "question.unmatched", {
          sessionID: event.sessionID,
          blockId: block.blockId,
          decision: outcome.decision,
        });
      }
    });

    // ── intent_context tool (SPEC §4.2) ────────────────────────────────
    const toolRegistration = await ctx.tool.transform((editor) => {
      editor.add(createIntentContextTool({ getCfg: () => cfg, directory: ctx.location.directory }));
    });

    // ── Cleanup (SPEC §6) ──────────────────────────────────────────────
    return async () => {
      abort.abort();
      for (const st of states.values()) {
        if (st.debounce) clearTimeout(st.debounce);
      }
      states.clear();
      store.clear();
      store.clearReplay();
      clearGuardCache();
      await toolRegistration.dispose();
    };
  },
});
