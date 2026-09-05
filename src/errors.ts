export const CASTLEGATE_TAG = "CASTLEGATE_INTENT_MISMATCH";

export class CastlegateIntentMismatchError extends Error {
  readonly tag = CASTLEGATE_TAG;
  readonly tool: string;
  readonly reason: string;
  readonly severity: "low" | "medium" | "high";

  constructor(tool: string, reason: string, severity: "low" | "medium" | "high") {
    const message =
      `${CASTLEGATE_TAG}: tool '${tool}' did not match the current session intent.\n` +
      `Reason: ${reason}\n` +
      `Severity: ${severity}\n` +
      `Action required: surface this to the user via the question tool and wait for explicit approval before retrying the tool call.`;
    super(message);
    this.name = "CastlegateIntentMismatchError";
    this.tool = tool;
    this.reason = reason;
    this.severity = severity;
  }

  static isMismatch(err: unknown): err is CastlegateIntentMismatchError {
    return (
      err instanceof CastlegateIntentMismatchError ||
      (err instanceof Error && err.message.startsWith(`${CASTLEGATE_TAG}:`))
    );
  }
}
