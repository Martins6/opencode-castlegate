/**
 * Gate node (SPEC §3.2 Gate row, §5.2).
 *
 * Decides whether new user-authored messages change the session intent.
 * One `noul` question to the decision model: P(update intent). Update when
 * `P ≥ decision.gateThreshold`; always update when no intent exists yet.
 */

import type { CastlegateConfig } from "./config.ts";
import {
  askDecision,
  noulProbability,
  type AskDecisionArgs,
  type DecisionAnswers,
} from "./decision.ts";
import { buildDecisionState } from "./state.ts";

export type AskFn = (args: AskDecisionArgs) => Promise<DecisionAnswers>;

export interface GateInput {
  /** Current intent body; empty string when no intent file exists yet. */
  currentIntent: string;
  /** The new user-authored text (never assistant text or tool output). */
  userText: string;
}

export interface GateResult {
  update: boolean;
  probability: number;
  reason: string;
}

const GATE_QUESTION =
  "Do these new user messages change the session intent described in the state? " +
  "Yes means they add, change, or revoke a goal, task, or constraint of the user. " +
  "When in doubt, answer yes.";

export async function runGate(
  cfg: CastlegateConfig,
  input: GateInput,
  opts: { signal?: AbortSignal; ask?: AskFn } = {},
): Promise<GateResult> {
  if (input.currentIntent.trim() === "") {
    return {
      update: true,
      probability: 1,
      reason: "gate: no intent yet — first update",
    };
  }

  const ask = opts.ask ?? askDecision;
  const state = buildDecisionState(
    input.currentIntent,
    `New user message(s):\n${input.userText}`,
    cfg.decision.stateMaxChars,
  );

  const answers = await ask({
    cfg,
    state,
    questions: {
      intent_change: { type: "noul", instructions: GATE_QUESTION },
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const probability = noulProbability(answers, "intent_change") ?? 0;
  return {
    update: probability >= cfg.decision.gateThreshold,
    probability,
    reason: `gate: P(update)=${probability.toFixed(2)} threshold=${cfg.decision.gateThreshold}`,
  };
}
