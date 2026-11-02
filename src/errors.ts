// Tagged errors (SPEC §4.3). Every error carries a stable `tag` and a stable
// message format so the agent can parse them; isCastlegateError() is duck-typed
// on the tag so it works across realms and duplicated module copies (§5.7).

export type CastlegateErrorTag =
  | "CASTLEGATE_INTENT_MISMATCH"
  | "CASTLEGATE_API_UNAVAILABLE"
  | "CASTLEGATE_INTENT_TOO_LONG"
  | "CASTLEGATE_HEADLESS_BLOCK"
  | "CASTLEGATE_NO_INTENT"
  | "CASTLEGATE_NO_INTENT_EXHAUSTED"
  | "CASTLEGATE_DECISION_SERVER_NOT_FOUND";

const CASTLEGATE_TAGS: ReadonlySet<string> = new Set<CastlegateErrorTag>([
  "CASTLEGATE_INTENT_MISMATCH",
  "CASTLEGATE_API_UNAVAILABLE",
  "CASTLEGATE_INTENT_TOO_LONG",
  "CASTLEGATE_HEADLESS_BLOCK",
  "CASTLEGATE_NO_INTENT",
  "CASTLEGATE_NO_INTENT_EXHAUSTED",
  "CASTLEGATE_DECISION_SERVER_NOT_FOUND",
]);

/** Structural view of any castlegate-tagged error (works across realms). */
export interface CastlegateTagged {
  readonly tag: CastlegateErrorTag;
}

/** Duck-typed guard: true for anything carrying one of the castlegate tags. */
export function isCastlegateError(err: unknown): err is CastlegateTagged {
  if (typeof err !== "object" || err === null) return false;
  const tag = (err as { tag?: unknown }).tag;
  return typeof tag === "string" && CASTLEGATE_TAGS.has(tag);
}

// ---------------------------------------------------------------------------
// CASTLEGATE_INTENT_MISMATCH (SPEC §3.5, §4.3)
// ---------------------------------------------------------------------------

export type MismatchSeverity = "low" | "medium" | "high";

export interface CastlegateIntentMismatchOptions {
  tool: string;
  reason: string;
  severity: MismatchSeverity;
  /** ISO timestamp of the block. */
  blockedAt: string;
  /** binds the approval to this exact block (§3.5). */
  blockId: string;
  /** approval.absorbWaitSeconds from config. */
  absorbWaitSeconds: number;
}

export class CastlegateIntentMismatchError extends Error {
  readonly tag = "CASTLEGATE_INTENT_MISMATCH";
  readonly tool: string;
  readonly reason: string;
  readonly severity: MismatchSeverity;
  readonly blockedAt: string;
  readonly blockId: string;
  readonly absorbWaitSeconds: number;

  constructor(opts: CastlegateIntentMismatchOptions) {
    const message =
      `CASTLEGATE_INTENT_MISMATCH: tool '${opts.tool}' did not match the current session intent.\n` +
      `Reason: ${opts.reason}\n` +
      `Severity: ${opts.severity}\n` +
      `Blocked at: ${opts.blockedAt}\n` +
      `Block id: ${opts.blockId}\n` +
      `Action required: surface this to the user via the question tool with exactly two options: Approve / Deny, including the block id verbatim in the question. Tell the user to pick the Approve option or type exactly 'approve' — any other answer counts as refusal. Only an explicit 'approve' unlocks the command; free text never does.\n` +
      `If the user approves: the clearance is absorbed into the intent within ${opts.absorbWaitSeconds}s — a CASTLEGATE_CLEARANCE line carrying the approval time is appended to the question result, so you can count elapsed time. Retry the same command immediately; wait ${opts.absorbWaitSeconds}s before expecting similar commands to pass without asking.\n` +
      `If the user denies: do not retry the tool call.`;
    super(message);
    this.name = "CastlegateIntentMismatchError";
    this.tool = opts.tool;
    this.reason = opts.reason;
    this.severity = opts.severity;
    this.blockedAt = opts.blockedAt;
    this.blockId = opts.blockId;
    this.absorbWaitSeconds = opts.absorbWaitSeconds;
  }
}

// ---------------------------------------------------------------------------
// CASTLEGATE_API_UNAVAILABLE (SPEC §5.4)
// ---------------------------------------------------------------------------

export type ApiNode = "gate" | "guard";

export interface CastlegateApiUnavailableOptions {
  node: ApiNode;
  baseURL: string;
  attempts: number;
}

export class CastlegateApiUnavailableError extends Error {
  readonly tag = "CASTLEGATE_API_UNAVAILABLE";
  readonly node: ApiNode;
  readonly baseURL: string;
  readonly attempts: number;

  constructor(opts: CastlegateApiUnavailableOptions) {
    const message =
      `CASTLEGATE_API_UNAVAILABLE: castlegate cannot reach the ${opts.node} decision server at ${opts.baseURL} after ${opts.attempts} attempts.\n` +
      `The plugin cannot make safety decisions.\n` +
      `Set "enabled": false or comment out opencode-castlegate in opencode.json until the API is back.`;
    super(message);
    this.name = "CastlegateApiUnavailableError";
    this.node = opts.node;
    this.baseURL = opts.baseURL;
    this.attempts = opts.attempts;
  }
}

// ---------------------------------------------------------------------------
// CASTLEGATE_INTENT_TOO_LONG (SPEC §5.6)
// ---------------------------------------------------------------------------

export interface CastlegateIntentTooLongOptions {
  maxChars: number;
  shrinkAttempts: number;
}

export class CastlegateIntentTooLongError extends Error {
  readonly tag = "CASTLEGATE_INTENT_TOO_LONG";
  readonly maxChars: number;
  readonly shrinkAttempts: number;

  constructor(opts: CastlegateIntentTooLongOptions) {
    const message =
      `CASTLEGATE_INTENT_TOO_LONG: intent body exceeded ${opts.maxChars} characters after ${opts.shrinkAttempts} attempts.\n` +
      `The previous intent was kept unchanged.\n` +
      `Please open an issue at https://github.com/Martins6/opencode-castlegate`;
    super(message);
    this.name = "CastlegateIntentTooLongError";
    this.maxChars = opts.maxChars;
    this.shrinkAttempts = opts.shrinkAttempts;
  }
}

// ---------------------------------------------------------------------------
// CASTLEGATE_HEADLESS_BLOCK (SPEC §3.6, §4.3)
// ---------------------------------------------------------------------------

export interface CastlegateHeadlessBlockedOptions {
  tool: string;
  reason: string;
  severity: MismatchSeverity;
  blockedAt: string; // ISO timestamp
}

export class CastlegateHeadlessBlockedError extends Error {
  readonly tag = "CASTLEGATE_HEADLESS_BLOCK";
  readonly tool: string;
  readonly reason: string;
  readonly severity: MismatchSeverity;
  readonly blockedAt: string;

  constructor(opts: CastlegateHeadlessBlockedOptions) {
    const message =
      `CASTLEGATE_HEADLESS_BLOCK: tool '${opts.tool}' is blocked and cannot be approved here.\n` +
      `Reason: ${opts.reason}\n` +
      `Severity: ${opts.severity}\n` +
      `Blocked at: ${opts.blockedAt}\n` +
      `This session is headless: the user cannot approve or reject your action right now.\n` +
      `Action required: do NOT try to approve this. Use a different shell command that fits the user's stated intent. If this exact command is truly necessary, tell the user to run it from an interactive session.`;
    super(message);
    this.name = "CastlegateHeadlessBlockedError";
    this.tool = opts.tool;
    this.reason = opts.reason;
    this.severity = opts.severity;
    this.blockedAt = opts.blockedAt;
  }
}

// ---------------------------------------------------------------------------
// CASTLEGATE_NO_INTENT / CASTLEGATE_NO_INTENT_EXHAUSTED (SPEC §5.5)
// ---------------------------------------------------------------------------

export interface CastlegateNoIntentOptions {
  tool: string;
  attempt: number;
  maxAttempts: number;
  retrySeconds: number;
}

export class CastlegateNoIntentError extends Error {
  readonly tag = "CASTLEGATE_NO_INTENT";
  readonly tool: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly retrySeconds: number;

  constructor(opts: CastlegateNoIntentOptions) {
    const message =
      `CASTLEGATE_NO_INTENT: tool '${opts.tool}' is blocked: the session intent is not established yet (attempt ${opts.attempt} of ${opts.maxAttempts}).\n` +
      `The intent lands within seconds of the first user message.\n` +
      `Action required: wait ${opts.retrySeconds}s, then retry this exact call once. Do not retry sooner.`;
    super(message);
    this.name = "CastlegateNoIntentError";
    this.tool = opts.tool;
    this.attempt = opts.attempt;
    this.maxAttempts = opts.maxAttempts;
    this.retrySeconds = opts.retrySeconds;
  }
}

export interface CastlegateNoIntentExhaustedOptions {
  tool: string;
  maxAttempts: number;
}

export class CastlegateNoIntentExhaustedError extends Error {
  readonly tag = "CASTLEGATE_NO_INTENT_EXHAUSTED";
  readonly tool: string;
  readonly maxAttempts: number;

  constructor(opts: CastlegateNoIntentExhaustedOptions) {
    const message =
      `CASTLEGATE_NO_INTENT_EXHAUSTED: tool '${opts.tool}' is blocked: the session intent never appeared after ${opts.maxAttempts} attempts.\n` +
      `Something is wrong with castlegate — it cannot validate tool calls and keeps blocking this session.\n` +
      `Action required: stop retrying. Ask the user to decide whether to disable the opencode-castlegate plugin ("enabled": false or comment it out in opencode.json) — something is wrong and needs fixing.`;
    super(message);
    this.name = "CastlegateNoIntentExhaustedError";
    this.tool = opts.tool;
    this.maxAttempts = opts.maxAttempts;
  }
}

// ---------------------------------------------------------------------------
// CASTLEGATE_DECISION_SERVER_NOT_FOUND (SPEC §4.4 — no default setup)
// ---------------------------------------------------------------------------

export class CastlegateDecisionServerNotFoundError extends Error {
  readonly tag = "CASTLEGATE_DECISION_SERVER_NOT_FOUND";

  constructor() {
    const message =
      `CASTLEGATE_DECISION_SERVER_NOT_FOUND: castlegate has no decision model server configured, so it cannot validate tool calls.\n` +
      `Set "decision.baseURL" (and "decision.model") in opencode.json to a System One server running a decision model — see the README's decision-model setup section.\n` +
      `Action required: tell the user that castlegate needs a decision model server configured. Gated tool calls stay blocked until then.`;
    super(message);
    this.name = "CastlegateDecisionServerNotFoundError";
  }
}
