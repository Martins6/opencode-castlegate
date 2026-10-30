/**
 * Guard node (SPEC §3.2 Guard row, §3.4 guard cache, §5.2).
 *
 * Decides safe / not safe for a proposed tool call against the intent.
 * One forward pass with two typed questions (choice + score). Safe iff the
 * top choice is `within_scope` AND `confidence ≥ decision.safeConfidence`;
 * low confidence counts as not safe (uncertain → escalate to the user).
 */

import { createHash } from "node:crypto";
import type { CastlegateConfig } from "./config.ts";
import {
  askDecision,
  canonicalJSON,
  expectedScore,
  topChoice,
  type AskDecisionArgs,
  type DecisionAnswers,
} from "./decision.ts";
import { buildDecisionState } from "./state.ts";

export type AskFn = (args: AskDecisionArgs) => Promise<DecisionAnswers>;

export interface GuardInput {
  tool: string;
  args: Record<string, unknown>;
  intentBody: string;
  intentVersion: number;
}

export interface GuardVerdict {
  safe: boolean;
  scope: "within_scope" | "out_of_scope";
  confidence: number;
  severity: "low" | "medium" | "high";
  /** Synthesized decision evidence (the decision model returns no free text). */
  reason: string;
  cached: boolean;
}

const SCOPE_QUESTION =
  "Is this proposed tool call within the scope of the user's session intent described in the state?";
const SCOPE_CRITERIA = {
  within_scope: "The call serves a goal, task, or constraint the user stated",
  out_of_scope: "The call is unrelated to, beyond, or against what the user stated",
} as const;

const SEVERITY_QUESTION =
  "If this call is not what the user wants, how severe is the damage?";
const SEVERITY_LEVELS = [
  "harmless or easily reversible",
  "significant but recoverable",
  "destructive or irreversible",
] as const;

const SEVERITY_LABELS = ["harmless", "recoverable", "destructive"] as const;

function severityOf(score: number): { severity: "low" | "medium" | "high"; label: string } {
  if (score < 0.5) return { severity: "low", label: SEVERITY_LABELS[0] };
  if (score < 1.5) return { severity: "medium", label: SEVERITY_LABELS[1] };
  return { severity: "high", label: SEVERITY_LABELS[2] };
}

function synthesizeReason(
  scope: string,
  probability: number,
  confidence: number,
  score: number,
  label: string,
): string {
  return (
    `decision: ${scope} p=${probability.toFixed(2)}, ` +
    `confidence ${confidence.toFixed(2)}, severity ${score.toFixed(1)}/2 (${label})`
  );
}

export function buildGuardState(
  input: Pick<GuardInput, "intentBody" | "tool" | "args">,
  stateMaxChars: number,
): string {
  return buildDecisionState(
    input.intentBody,
    `Proposed ${input.tool} call:\n${canonicalJSON(input.args)}`,
    stateMaxChars,
  );
}

/** Uncached guard decision — one forward pass, choice + score. */
export async function runGuard(
  cfg: CastlegateConfig,
  input: GuardInput,
  opts: { signal?: AbortSignal; ask?: AskFn } = {},
): Promise<GuardVerdict> {
  const ask = opts.ask ?? askDecision;
  const answers = await ask({
    cfg,
    state: buildGuardState(input, cfg.decision.stateMaxChars),
    questions: {
      scope: { type: "choice", instructions: SCOPE_QUESTION, criteria: { ...SCOPE_CRITERIA } },
      severity: { type: "score", instructions: SEVERITY_QUESTION, criteria: [...SEVERITY_LEVELS] },
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const top = topChoice(answers, "scope");
  const scope: "within_scope" | "out_of_scope" = top?.choice === "within_scope" ? "within_scope" : "out_of_scope";
  const confidence = top?.confidence ?? 0;
  const probability = top?.probability ?? 0;
  const score = expectedScore(answers, "severity") ?? 0;
  const { severity, label } = severityOf(score);

  return {
    safe: scope === "within_scope" && confidence >= cfg.decision.safeConfidence,
    scope,
    confidence,
    severity,
    reason: synthesizeReason(scope, probability, confidence, score, label),
    cached: false,
  };
}

// ── Guard cache (SPEC §3.4) ──────────────────────────────────────────────
// Key: sha256(tool + "\0" + canonicalJSON(args) + "\0" + intentVersion).
// Canonical JSON means key order never splits the cache (SPEC §5.7).

interface CacheEntry {
  verdict: GuardVerdict;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function guardCacheKey(input: GuardInput): string {
  return createHash("sha256")
    .update(`${input.tool}\0${canonicalJSON(input.args)}\0${input.intentVersion}`)
    .digest("hex");
}

export function clearGuardCache(): void {
  cache.clear();
}

export async function guardToolCall(
  cfg: CastlegateConfig,
  input: GuardInput,
  opts: { signal?: AbortSignal; ask?: AskFn; now?: () => number } = {},
): Promise<GuardVerdict> {
  const now = opts.now ?? Date.now;
  const ttl = cfg.validate.cacheTtlMs;
  const key = guardCacheKey(input);

  if (ttl > 0) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return { ...hit.verdict, cached: true };
  }

  const verdict = await runGuard(cfg, input, opts);
  if (ttl > 0) {
    cache.set(key, { verdict, expiresAt: now() + ttl });
  }
  return verdict;
}
