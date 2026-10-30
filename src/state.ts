/**
 * Decision-state assembly (SPEC §5.7 "Size discipline").
 *
 * The state sent to the decision server must fit `decision.stateMaxChars`
 * (d1-omni reads a whole question in one batch). When trimming, the anchor
 * intent (document head) and the clearance entries survive first.
 */

const CLEARANCE_RE = /user approved/i;

export function buildDecisionState(intentBody: string, extra: string, maxChars: number): string {
  const head = "Session intent:";
  const extraBlock = extra.trim().length > 0 ? `\n\n${extra.trim()}` : "";

  const full = `${head}\n${intentBody}${extraBlock}`;
  if (full.length <= maxChars) return full;

  // Over budget: keep the anchor (intent head) and the clearance entries —
  // the tail is where stale detail and clearances live, so clearances are
  // re-added explicitly before truncation removes them.
  const clearanceLines = intentBody.split("\n").filter((l) => CLEARANCE_RE.test(l));
  const clearanceBlock =
    clearanceLines.length > 0 ? `\n\nApproved clearances:\n${clearanceLines.join("\n")}` : "";

  const fixed = head.length + clearanceBlock.length + extraBlock.length + 1;
  const intentBudget = Math.max(0, maxChars - fixed);
  const trimmedIntent =
    intentBody.length > intentBudget ? intentBody.slice(0, intentBudget) : intentBody;

  const assembled = `${head}\n${trimmedIntent}${clearanceBlock}${extraBlock}`;
  // Last resort: the extra block is the lowest-priority content (SPEC §5.7
  // keeps anchor + clearances first), so it is what loses when nothing fits.
  return assembled.length > maxChars ? assembled.slice(0, maxChars) : assembled;
}
