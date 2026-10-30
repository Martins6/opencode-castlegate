/**
 * Update node orchestrator (SPEC §3.2 Update row, §3.3 CAS, §5.6 shrink loop).
 *
 * Takes the current on-disk intent plus one change event, asks the injected
 * generator for a revised intent, enforces the max-chars limit via the shrink
 * loop, and saves with compare-and-swap on intentVersion.
 *
 * Nothing here throws: every failure is a tagged result the caller maps to a
 * tagged error or a log event.
 */

import type { CastlegateConfig } from "./config.ts";
import { loadIntent, saveIntent, type IntentHeader } from "./store.ts";
import {
  buildIntentUpdatePrompt,
  extractIntentBody,
  type IntentChange,
} from "./prompts/intent-update.ts";

export interface IntentUpdateDeps {
  /** Wraps ctx.generate.text({ prompt, model }) in production; stubbed in tests. */
  generate: (prompt: string) => Promise<string>;
  /** Absolute storage dir (resolveStorageDir output). */
  dir: string;
  config: CastlegateConfig;
}

export interface RunIntentUpdateArgs {
  sessionId: string;
  change: IntentChange;
  expectedVersion: number;
  lastMessageId?: string | null;
}

export type IntentUpdateResult =
  | { ok: true; header: IntentHeader; notes?: string[] }
  | { ok: false; reason: "too_long"; notes?: string[] }
  | { ok: false; reason: "version_conflict"; notes?: string[] }
  | { ok: false; reason: "tombstoned"; notes?: string[] }
  | { ok: false; reason: "generate_error"; message: string; notes?: string[] };

const SHRINK_REMINDER = (maxChars: number): string =>
  `Make it smaller, you've passed the ${maxChars} limit.`;

/**
 * One generate-and-shrink cycle against the current intent (SPEC §5.6).
 * Up to `shrinkAttempts` generations total: the first from the change event,
 * each subsequent one re-prompted with the oversize draft.
 */
async function generateBody(
  deps: IntentUpdateDeps,
  currentIntent: string,
  change: IntentChange,
): Promise<
  | { ok: true; body: string; attempts: number }
  | { ok: false; reason: "too_long" | "generate_error"; message?: string; attempts: number }
> {
  const { maxChars, shrinkAttempts, maxRecentMessages } = deps.config.intent;

  const prompt = buildIntentUpdatePrompt({
    currentIntent,
    change,
    maxChars,
    maxRecentMessages,
  });

  let body: string;
  let attempts = 0;

  try {
    body = extractIntentBody(await deps.generate(prompt));
  } catch (err) {
    return {
      ok: false,
      reason: "generate_error",
      message: err instanceof Error ? err.message : String(err),
      attempts: 0,
    };
  }
  attempts = 1;

  while (body.length > maxChars && attempts < shrinkAttempts) {
    const shrinkPrompt = `${SHRINK_REMINDER(maxChars)}\n\nHere is the oversize draft to shrink:\n\n${body}`;
    try {
      body = extractIntentBody(await deps.generate(shrinkPrompt));
    } catch (err) {
      return {
        ok: false,
        reason: "generate_error",
        message: err instanceof Error ? err.message : String(err),
        attempts,
      };
    }
    attempts++;
  }

  if (body.length > maxChars) {
    return { ok: false, reason: "too_long", attempts };
  }
  return { ok: true, body, attempts };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failure(
  reason: "too_long" | "version_conflict" | "tombstoned" | "generate_error",
  notes: string[],
  message?: string,
): IntentUpdateResult {
  const withNotes = notes.length > 0 ? { notes } : {};
  if (reason === "generate_error") {
    return { ok: false, reason, message: message ?? "", ...withNotes };
  }
  return { ok: false, reason, ...withNotes };
}

export async function runIntentUpdate(
  deps: IntentUpdateDeps,
  args: RunIntentUpdateArgs,
): Promise<IntentUpdateResult> {
  const notes: string[] = [];
  // Initial run + at most one whole re-run on CAS conflict (SPEC §3.3).
  const maxRuns = 2;
  let expectedVersion = args.expectedVersion;

  for (let run = 0; run < maxRuns; run++) {
    const existing = await loadIntent(deps.dir, args.sessionId);
    const currentIntent = existing?.body ?? "";
    if (run > 0) {
      // Re-run against the fresh version the conflict reported.
      expectedVersion = existing?.header.intentVersion ?? 0;
    }

    const generated = await generateBody(deps, currentIntent, args.change);
    if (!generated.ok) {
      notes.push(`generation attempts: ${generated.attempts}`);
      return failure(generated.reason, notes, generated.message);
    }
    if (generated.attempts > 1) {
      notes.push(`shrink loop used ${generated.attempts} of ${deps.config.intent.shrinkAttempts} attempts`);
    }

    const saved = await saveIntent(deps.dir, args.sessionId, generated.body, {
      expectedVersion,
      ...(args.lastMessageId !== undefined ? { lastMessageId: args.lastMessageId } : {}),
    });

    if (saved.saved) {
      notes.push(`update run: ${run + 1}`);
      return { ok: true, header: saved.header, ...(notes.length > 0 ? { notes } : {}) };
    }
    if (saved.reason === "tombstoned") {
      return failure("tombstoned", notes);
    }
    // version_conflict: loop once more against the fresh version; a second
    // conflict gives up (the draft is discarded, never clobbers).
    notes.push(`CAS conflict: version ${expectedVersion} → ${saved.currentVersion}`);
  }

  return failure("version_conflict", notes);
}
