// Approval absorption machinery (SPEC §3.5). Pure logic + injected side
// effects: this module must NOT import the plugin SDK and must NOT do fs I/O.
//
// Trust boundaries (SPEC §5.7): approvals are bound to a blockId — an answer
// without a pending blockId never clears anything, the plugin (not the agent)
// states which exact command is approved, and signature matching is canonical
// (sorted-key JSON before hashing) so key order can never change a verdict.

import { createHash, randomBytes } from "node:crypto";
import { canonicalJSON } from "./decision.ts";
import type { IntentChange } from "./prompts/intent-update.ts";

// ---------------------------------------------------------------------------
// Command signature (SPEC §3.5 step 4)
// ---------------------------------------------------------------------------

/** sha256 over `tool + "\0" + canonicalJSON(args)` → lowercase hex. */
export function canonicalSignature(tool: string, args: unknown): string {
  const json = canonicalJSON(args);
  return createHash("sha256").update(`${tool}\0${json}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Pending blocks (SPEC §3.5 step 1)
// ---------------------------------------------------------------------------

export interface PendingBlock {
  blockId: string;
  sessionId: string;
  tool: string;
  args: unknown;
  signature: string;
  /** ISO timestamp of the block. */
  blockedAt: string;
}

export interface OpenBlockInput {
  sessionId: string;
  tool: string;
  args: unknown;
  now?: () => number;
}

export function openBlock(input: OpenBlockInput): PendingBlock {
  const nowMs = (input.now ?? Date.now)();
  return {
    blockId: `cb_${randomBytes(4).toString("hex")}`,
    sessionId: input.sessionId,
    tool: input.tool,
    args: input.args,
    signature: canonicalSignature(input.tool, input.args),
    blockedAt: new Date(nowMs).toISOString(),
  };
}

/** The command string the plugin — not the agent — states as approved. */
export function blockedCommand(block: PendingBlock): string {
  const args = block.args;
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    const command = (args as Record<string, unknown>)["command"];
    if (typeof command === "string") return command;
  }
  return canonicalJSON(args);
}

// ---------------------------------------------------------------------------
// Store: pending blocks + replay journal (SPEC §3.5 steps 1 and 4)
// ---------------------------------------------------------------------------

export class PendingBlockStore {
  private readonly blocks = new Map<string, PendingBlock>();
  /** signature → expiry epoch ms (wall clock per the owner's decision). */
  private readonly replay = new Map<string, number>();

  add(block: PendingBlock): void {
    this.blocks.set(block.blockId, block);
  }

  get(blockId: string): PendingBlock | undefined {
    return this.blocks.get(blockId);
  }

  /** The pending block whose blockId appears in promptText for this session. */
  findForPrompt(sessionId: string, promptText: string): PendingBlock | undefined {
    for (const block of this.blocks.values()) {
      if (block.sessionId === sessionId && promptText.includes(block.blockId)) return block;
    }
    return undefined;
  }

  delete(blockId: string): void {
    this.blocks.delete(blockId);
  }

  clear(): void {
    this.blocks.clear();
  }

  markReplayCleared(signature: string, ttlMs: number, now?: () => number): void {
    this.replay.set(signature, (now ?? Date.now)() + ttlMs);
  }

  isReplayCleared(signature: string, now?: () => number): boolean {
    const expiresAt = this.replay.get(signature);
    if (expiresAt === undefined) return false;
    if ((now ?? Date.now)() >= expiresAt) {
      // Expired entries are dead (wall-clock TTL): drop, never resurrect.
      this.replay.delete(signature);
      return false;
    }
    return true;
  }

  deleteReplay(signature: string): void {
    this.replay.delete(signature);
  }

  clearReplay(): void {
    this.replay.clear();
  }
}

export function createApprovalStore(): PendingBlockStore {
  return new PendingBlockStore();
}

// ---------------------------------------------------------------------------
// Question-input transform (SPEC §3.5 step 2)
// ---------------------------------------------------------------------------

/**
 * Inject `Blocked command: \`<exact args>\`` into the question tool's input.
 * The plugin does not trust the agent to describe the command: the block's own
 * args are appended verbatim. Returns a NEW object (never mutates the input);
 * when no string field carries the blockId the input is returned untouched
 * (unrelated questions never touch guard state).
 */
export function transformQuestionInput(input: unknown, block: PendingBlock): unknown {
  const suffix = `\n\nBlocked command: \`${blockedCommand(block)}\``;

  // The real question tool nests the prompt at `questions: [{ question, ... }]`
  // and option descriptions may also quote the blockId — so prefer fields named
  // `question` anywhere in the tree, then fall back to any string carrying it.
  let used = false;
  const walk = (node: unknown, onlyQuestionKeys: boolean): unknown => {
    if (used) return node;
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, onlyQuestionKeys));
    if (typeof node === "object" && node !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (
          !used &&
          typeof value === "string" &&
          value.includes(block.blockId) &&
          (!onlyQuestionKeys || key === "question")
        ) {
          used = true;
          out[key] = value + suffix;
        } else {
          out[key] = walk(value, onlyQuestionKeys);
        }
      }
      return out;
    }
    return node;
  };

  const preferred = walk(input, true);
  if (used) return preferred;
  const fallback = walk(input, false);
  return used ? fallback : input;
}

// ---------------------------------------------------------------------------
// Answer detection (SPEC §3.5 step 3) — FAIL-CLOSED
// ---------------------------------------------------------------------------

/** True ONLY for exactly "approve" (trimmed, case-folded). Free text never unlocks. */
export function isApproval(answerText: string): boolean {
  return answerText.trim().toLowerCase() === "approve";
}

/** Recognizable denial: exactly "deny" (trimmed, case-folded). */
export function isDenial(answerText: string): boolean {
  return answerText.trim().toLowerCase() === "deny";
}

/**
 * Tolerant extraction of the human-visible answer from a question tool result.
 * Real Tool.Result shape (node_modules/@opencode/schema/dist/tool.d.ts):
 * `{ output?, content?: string | ReadonlyArray<Content>, metadata? }` where a
 * text part is `{ type: "text", text: string }`. Also handles plain-string
 * results and `{ output: string }`.
 */
export function extractAnswerText(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result !== "object" || result === null) return "";

  const record = result as Record<string, unknown>;
  const parts: string[] = [];

  const content = record["content"];
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p["type"] === "text" && typeof p["text"] === "string") parts.push(p["text"]);
    }
  }
  if (parts.length > 0) return parts.join("\n");

  const output = record["output"];
  return typeof output === "string" ? output : "";
}

/**
 * Candidate answers from a question tool result. The real result renders each
 * answer as `question text="selected label"`; structured `answers` fields are
 * honored first. Falls back to the whole visible text (still fail-closed: the
 * caller matches labels exactly).
 */
export function extractAnswerLabels(result: unknown): string[] {
  const labels: string[] = [];

  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    if (typeof node === "string") {
      if (node.trim()) labels.push(node.trim());
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const value of Object.values(node as Record<string, unknown>)) collect(value);
    }
  };

  if (result && typeof result === "object") {
    const answers = (result as Record<string, unknown>)["answers"];
    if (answers !== undefined) {
      collect(answers);
      if (labels.length > 0) return labels;
    }
  }

  const text = extractAnswerText(result);
  const pairs = [...text.matchAll(/="([^"]*)"/g)].map((m) => (m[1] ?? "").trim());
  const fromPairs = pairs.filter((v) => v !== "");
  if (fromPairs.length > 0) return fromPairs;

  return text.trim() ? [text.trim()] : [];
}

// ---------------------------------------------------------------------------
// Question-result consumption (SPEC §3.5 step 3)
// ---------------------------------------------------------------------------

export interface ApproveOutcome {
  decision: "approve";
  approvedAt: string;
  /** the CASTLEGATE_CLEARANCE line the plugin appends to the question result. */
  clearanceLine: string;
}

export type ConsumeOutcome = ApproveOutcome | { decision: "deny" } | { decision: "unmatched" };

/**
 * Consume a question result bound to a pending block (fail-closed):
 * - approval counts only when the extracted answer is exactly "approve";
 * - "deny" (exact, case/trim-insensitive) is a recognizable denial;
 * - anything else is "unmatched" — the caller treats it as denial but may log it.
 * On approval the pending block is consumed (deleted); denials leave it pending.
 * Replay marking is the caller's job (it owns replayTtlMs from config).
 */
export function consumeQuestionResult(
  store: PendingBlockStore,
  block: PendingBlock,
  result: unknown,
  now: () => number = Date.now,
  absorbWaitSeconds = 60,
): ConsumeOutcome {
  const labels = extractAnswerLabels(result);

  // Fail-closed precedence: any explicit denial wins; approval needs an
  // explicit "approve" label; anything else is unmatched (treated as denial).
  if (labels.some((label) => isDenial(label))) return { decision: "deny" };

  if (labels.some((label) => isApproval(label))) {
    const approvedAt = new Date(now()).toISOString();
    const clearanceLine =
      `CASTLEGATE_CLEARANCE: approvedAt ${approvedAt} — ` +
      `the intent absorbs this clearance within ${absorbWaitSeconds}s.`;
    store.delete(block.blockId);
    return { decision: "approve", approvedAt, clearanceLine };
  }

  return { decision: "unmatched" };
}

// ---------------------------------------------------------------------------
// Absorption (SPEC §3.5 step 5)
// ---------------------------------------------------------------------------

export interface AbsorbDeps {
  absorb: (change: IntentChange) => Promise<unknown>;
  /** called when absorption outlives replayTtlMs — a bug signal (§3.5 step 5). */
  onAbsorbSlow?: (info: { durationMs: number; replayTtlMs: number }) => void;
  onAbsorbError?: (err: unknown) => void;
  replayTtlMs: number;
  /** clock injection for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Fire the absorb call for an approved clearance. NEVER throws: errors go to
 * onAbsorbError; a duration beyond replayTtlMs goes to onAbsorbSlow.
 */
export async function absorbClearance(
  deps: AbsorbDeps,
  block: PendingBlock,
  approvedAt: string,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const start = now();
  try {
    await deps.absorb({
      type: "clearance",
      command: blockedCommand(block),
      approvedAt,
      blockId: block.blockId,
    });
  } catch (err) {
    deps.onAbsorbError?.(err);
    return;
  }
  const durationMs = now() - start;
  if (durationMs > deps.replayTtlMs) {
    deps.onAbsorbSlow?.({ durationMs, replayTtlMs: deps.replayTtlMs });
  }
}
