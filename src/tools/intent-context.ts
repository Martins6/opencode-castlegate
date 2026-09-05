import { z } from "zod";
import { tool } from "@opencode-ai/plugin";
import { loadDigest, resolveStorageDir } from "../store.ts";
import type { CastlegateConfig } from "../config.ts";

export function createIntentContextTool(getCfg: () => CastlegateConfig) {
  return tool({
    description:
      "Return the current castlegate intent digest for this session. Use this to inspect what the auto-approve guardrail currently believes the session's intent is.",
    args: {
      format: z.enum(["summary", "raw"]).default("summary"),
    },
    async execute(args, context) {
      const cfg = getCfg();
      const dir = resolveStorageDir(context.directory, cfg.storage.directory);
      const file = await loadDigest(dir, context.sessionID);

      if (!file) {
        const out = "(no intent digest yet for this session)";
        return { title: "castlegate intent_context", output: out, metadata: { exists: false } };
      }

      if (args.format === "raw") {
        return {
          title: "castlegate intent_context",
          output: `# castlegate intent digest\n\n${file.body}`,
          metadata: {
            version: file.header.digestVersion,
            lastMessageId: file.header.lastMessageId,
            updatedAt: file.header.updatedAt,
            charCount: file.header.charCount,
          },
        };
      }

      const out = [
        `# castlegate intent digest`,
        ``,
        `Version: ${file.header.digestVersion}`,
        `Updated: ${file.header.updatedAt}`,
        `Chars:   ${file.header.charCount}`,
        `LastMsg: ${file.header.lastMessageId ?? "(none)"}`,
        ``,
        file.body,
      ].join("\n");

      return {
        title: "castlegate intent_context",
        output: out,
        metadata: {
          version: file.header.digestVersion,
          lastMessageId: file.header.lastMessageId,
          updatedAt: file.header.updatedAt,
          charCount: file.header.charCount,
        },
      };
    },
  });
}
