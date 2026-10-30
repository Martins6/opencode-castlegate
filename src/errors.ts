// Tagged errors (SPEC §4.3). Every error carries a stable `tag` and a stable
// message format so the agent can parse them; isCastlegateError() is duck-typed
// on the tag so it works across realms and duplicated module copies (§5.7).

export type CastlegateErrorTag =
  | "CASTLEGATE_INTENT_MISMATCH"
  | "CASTLEGATE_API_UNAVAILABLE"
  | "CASTLEGATE_INTENT_TOO_LONG";

const CASTLEGATE_TAGS: ReadonlySet<string> = new Set<CastlegateErrorTag>([
  "CASTLEGATE_INTENT_MISMATCH",
  "CASTLEGATE_API_UNAVAILABLE",
  "CASTLEGATE_INTENT_TOO_LONG",
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
