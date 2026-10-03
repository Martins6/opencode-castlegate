import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { safeParseConfig, type CastlegateConfig } from "./config.ts";
import { CastlegateIntentMismatchError, CASTLEGATE_TAG } from "./errors.ts";
import {
  clearValidatorCache,
  shouldValidate,
  validateToolCall,
  fallbackDecision,
} from "./validate.ts";
import { createSidecar, updateDigest } from "./intent.ts";
import { loadDigest, resolveStorageDir, deleteDigest } from "./store.ts";
import { createLogger, redactedArgKeys } from "./log.ts";
import { createIntentContextTool } from "./tools/intent-context.ts";

interface SessionState {
  pendingDigestUpdate: ReturnType<typeof setTimeout> | null;
  debounceMs: number;
}

const DEBOUNCE_MS = 1000;

export const CastlegatePlugin: Plugin = async (input, options) => {
  const raw = (options ?? {}) as Record<string, unknown>;
  const parsed = safeParseConfig(raw);
  if (!parsed.ok) {
    await input.client.app
      .log({
        body: {
          service: "castlegate",
          level: "error",
          message: "invalid castlegate config; plugin disabled",
          extra: { issues: parsed.error.issues },
        },
      })
      .catch(() => {});
    return {};
  }

  const cfg: CastlegateConfig = parsed.config;
  const log = createLogger(input.client, cfg);
  const sidecar = createSidecar();
  const sessionStates = new Map<string, SessionState>();

  function getSessionState(sessionID: string): SessionState {
    let state = sessionStates.get(sessionID);
    if (!state) {
      state = { pendingDigestUpdate: null, debounceMs: DEBOUNCE_MS };
      sessionStates.set(sessionID, state);
    }
    return state;
  }

  function scheduleDigestUpdate(sessionID: string): void {
    const state = getSessionState(sessionID);
    if (state.pendingDigestUpdate) clearTimeout(state.pendingDigestUpdate);
    state.pendingDigestUpdate = setTimeout(() => {
      state.pendingDigestUpdate = null;
      void runDigestUpdate(sessionID);
    }, state.debounceMs);
  }

  async function runDigestUpdate(sessionID: string): Promise<void> {
    try {
      const result = await updateDigest(
        { client: input.client, sessionId: sessionID, cfg },
        sidecar,
      );
      if (!result.skipped) {
        await log.event("intent.updated", {
          sessionID,
          version: result.version,
          compacted: result.compacted,
          intentShift: result.intentShift,
          chars: result.digest.length,
        });
      }
    } catch (err) {
      await log.event("intent.update_error", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function ensureInitialized(sessionID: string): Promise<void> {
    const dir = resolveStorageDir(input.directory, cfg.storage.directory);
    const existing = await loadDigest(dir, sessionID);
    if (!existing) {
      const { saveDigest } = await import("./store.ts");
      await saveDigest(dir, sessionID, "", { baseVersion: 0, lastMessageId: null });
    }
  }

  return {
    dispose: async () => {
      for (const state of sessionStates.values()) {
        if (state.pendingDigestUpdate) clearTimeout(state.pendingDigestUpdate);
      }
      sessionStates.clear();
      clearValidatorCache();
    },

    event: async ({ event }) => {
      switch (event.type) {
        case "session.created": {
          const sessionID = (event.properties.info as { id?: string }).id;
          if (!sessionID) return;
          try {
            await ensureInitialized(sessionID);
            await log.event("session.initialized", { sessionID });
          } catch (err) {
            await log.event("session.init_error", {
              sessionID,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }
        case "session.deleted": {
          const sessionID = (event.properties.info as { id?: string }).id;
          if (!sessionID) return;
          try {
            const dir = resolveStorageDir(input.directory, cfg.storage.directory);
            await deleteDigest(dir, sessionID);
            sessionStates.delete(sessionID);
            await log.event("session.deleted", { sessionID });
          } catch (err) {
            await log.event("session.delete_error", {
              sessionID,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }
        case "message.updated": {
          const info = event.properties.info as { sessionID?: string; id?: string };
          const sessionID = info.sessionID;
          if (!sessionID) return;
          scheduleDigestUpdate(sessionID);
          break;
        }
        case "message.part.updated":
        case "message.part.removed":
        case "message.removed": {
          const props = event.properties as { sessionID?: string };
          if (props.sessionID) scheduleDigestUpdate(props.sessionID);
          break;
        }
      }
    },

    "tool.execute.before": async (toolInput, output) => {
      const { tool, sessionID } = toolInput;
      if (!sessionID) return;
      if (!shouldValidate(tool, cfg)) return;

      const dir = resolveStorageDir(input.directory, cfg.storage.directory);
      let file;
      try {
        file = await loadDigest(dir, sessionID);
      } catch (err) {
        await log.event("validate.digest_load_error", {
          sessionID,
          tool,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!cfg.validate.failOpenOnError) {
          throw new CastlegateIntentMismatchError(
            tool,
            "castlegate: digest store unavailable",
            "medium",
          );
        }
        return;
      }

      const digest = file?.body ?? "";
      const digestVersion = file?.header.digestVersion ?? 0;

      if (!digest) {
        await log.event("validate.skip_no_digest", { sessionID, tool });
        return;
      }

      let decision;
      try {
        decision = await validateToolCall({
          client: input.client,
          cfg,
          digest,
          digestVersion,
          tool,
          callArgs: output.args,
          sidecar,
        });
      } catch (err) {
        await log.event("validate.error", {
          sessionID,
          tool,
          error: err instanceof Error ? err.message : String(err),
        });
        const fallback = fallbackDecision(tool, cfg);
        if (fallback.match) return;
        throw new CastlegateIntentMismatchError(tool, fallback.reason, fallback.severity);
      }

      if (decision.result.match) {
        await log.event("validate.match", {
          sessionID,
          tool,
          cached: decision.cached,
          severity: decision.result.severity,
        });
        return;
      }

      await log.event("validate.mismatch", {
        sessionID,
        tool,
        reason: decision.result.reason,
        severity: decision.result.severity,
        argKeys: redactedArgKeys(output.args),
      });

      if (!cfg.validate.requireApprovalOnMismatch) {
        await log.event("validate.mismatch_allowed_by_config", { sessionID, tool });
        return;
      }

      throw new CastlegateIntentMismatchError(
        tool,
        decision.result.reason,
        decision.result.severity,
      );
    },

    tool: {
      intent_context: createIntentContextTool(() => cfg),
    },
  } satisfies Hooks;
};

export default CastlegatePlugin;
