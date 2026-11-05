/**
 * Decision-state assembly (SPEC §5.7 "Size discipline", §10 template pollution).
 *
 * The state sent to the decision server must fit `decision.stateMaxChars`
 * (d1-omni reads a whole question in one batch). When trimming, the anchor
 * intent (document head) and the clearance entries survive first.
 *
 * Template pollution (SPEC §10): placeholder-shaped clearance lines (e.g. a
 * pasted error template quoting `user approved \`<command>\``) must never reach
 * the decision model — it would read them as blanket approval. Only canonical
 * clearance entries count; every other approval-shaped line is dropped.
 * Fail-closed on purpose: a dropped real clearance re-blocks and re-asks
 * (annoying, safe), while a kept placeholder is blanket approval (unsafe).
 */

// The exact clearance-entry shape the Update node writes
// (prompts/intent-update.ts): "- <timestamp> — user approved `<command>` (clearance <blockId>)"
const CLEARANCE_LINE_RE =
  /^\s*[-*]\s+\S+\s+[—–-]\s+user approved\s+`([^`]+)`\s+\(clearance\s+\S+\)\s*$/i;

// Placeholder shapes inside a clearance entry (SPEC §10): angle-bracket tokens
// like `<command>`, or an ellipsis standing in for the real command.
const PLACEHOLDER_TOKEN_RE = /<[^<>]+>/;
const ELLIPSIS_ONLY_RE = /^[\s.…]+$/;

function isCanonicalClearance(line: string): boolean {
  const match = CLEARANCE_LINE_RE.exec(line);
  return (
    match !== null && !PLACEHOLDER_TOKEN_RE.test(line) && !ELLIPSIS_ONLY_RE.test(match[1] ?? "")
  );
}

/** Approval-shaped but not a canonical concrete clearance — template pollution. */
function isPollutedClearanceLine(line: string): boolean {
  return /user approved/i.test(line) && !isCanonicalClearance(line);
}

export function buildDecisionState(intentBody: string, extra: string, maxChars: number): string {
  const head = "Session intent:";
  const extraBlock = extra.trim().length > 0 ? `\n\n${extra.trim()}` : "";

  // Placeholder-shaped clearance lines are dropped up front — they must not
  // survive into the state even when the whole thing fits the budget (SPEC §10).
  const bodyLines = intentBody.split("\n").filter((l) => !isPollutedClearanceLine(l));
  const body = bodyLines.join("\n");

  const full = `${head}\n${body}${extraBlock}`;
  if (full.length <= maxChars) return full;

  // Over budget: keep the anchor (intent head) and the clearance entries —
  // the tail is where stale detail and clearances live, so clearances are
  // re-added explicitly before truncation removes them.
  const clearanceLines = bodyLines.filter((l) => isCanonicalClearance(l));
  const clearanceBlock =
    clearanceLines.length > 0 ? `\n\nApproved clearances:\n${clearanceLines.join("\n")}` : "";

  const fixed = head.length + clearanceBlock.length + extraBlock.length + 1;
  const intentBudget = Math.max(0, maxChars - fixed);
  const trimmedIntent = body.length > intentBudget ? body.slice(0, intentBudget) : body;

  const assembled = `${head}\n${trimmedIntent}${clearanceBlock}${extraBlock}`;
  // Last resort: the extra block is the lowest-priority content (SPEC §5.7
  // keeps anchor + clearances first), so it is what loses when nothing fits.
  return assembled.length > maxChars ? assembled.slice(0, maxChars) : assembled;
}
