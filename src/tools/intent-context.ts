/**
 * `intent_context` custom tool (SPEC §4.2) — V2 registration shape.
 *
 * Registered via ctx.tool.transform(editor => editor.add(...)); JSON Schema
 * input, structured result. Returns the current intent so the agent can see
 * what the guard validates against.
 */

import { loadIntent, resolveStorageDir } from "../store.ts";
import type { CastlegateConfig } from "../config.ts";

export interface IntentContextToolDeps {
  getCfg: () => CastlegateConfig;
  /** ctx.location.directory for storage resolution. */
  directory: string;
}

interface IntentContextInput {
  format?: "summary" | "raw";
}

export function createIntentContextTool(deps: IntentContextToolDeps) {
  return {
    name: "intent_context",
    description:
      "Return the current castlegate session intent: the goals and constraints shell commands are validated against.",
    input: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["summary", "raw"],
          description: 'summary (default) or the raw intent body',
        },
      },
      additionalProperties: false,
    },
    execute: async (input: unknown, context: { sessionID: string }) => {
      const { format } = (input ?? {}) as IntentContextInput;
      const cfg = deps.getCfg();
      const dir = resolveStorageDir(deps.directory, cfg.storage.directory);
      const file = await loadIntent(dir, context.sessionID);

      if (!file) {
        return {
          output: "No intent recorded for this session yet.",
          metadata: { version: 0, lastMessageId: null, updatedAt: null, charCount: 0 },
        };
      }

      const output =
        format === "raw"
          ? file.body
          : [
              `Intent (v${file.header.intentVersion}, updated ${file.header.updatedAt}):`,
              file.body || "(empty)",
            ].join("\n");

      return {
        output,
        metadata: {
          version: file.header.intentVersion,
          lastMessageId: file.header.lastMessageId,
          updatedAt: file.header.updatedAt,
          charCount: file.header.charCount,
        },
      };
    },
  };
}
