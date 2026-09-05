import type { CastlegateConfig } from "../config.ts";

export interface IntentUpdatePromptArgs {
  previousDigest: string;
  maxChars: number;
  newMessages: Array<{
    role: string;
    author?: string;
    text: string;
  }>;
  compact: boolean;
}

export function buildIntentUpdatePrompt(args: IntentUpdatePromptArgs): string {
  const { previousDigest, maxChars, newMessages, compact } = args;

  const messagesBlock = newMessages
    .map((m) => {
      const who = m.author ? `${m.role}/${m.author}` : m.role;
      return `[${who}] ${m.text}`;
    })
    .join("\n\n");

  const digestBlock = previousDigest
    ? previousDigest
    : "(no prior digest — first update for this session)";

  const instruction = compact
    ? "This update must REPLACE the previous digest with a shorter summary while preserving the anchor intent (the user's original goal)."
    : "This update MERGES the previous digest with new context. Preserve everything that still matters; drop nothing important.";

  return `You are the castlegate intent synthesizer. Maintain a compact digest of the user's session intent so downstream code can validate tool calls against it.

${instruction}

# Hard rules
- Stay under ${maxChars} characters total.
- Always preserve the ANCHOR INTENT (the user's original overarching goal) verbatim if it still appears to be the goal.
- Capture: (a) current objective, (b) active constraints/scope, (c) in-progress tasks, (d) explicit out-of-scope items, (e) recent intent shifts.
- Be terse. No prose, only structured bullets.
- NEVER execute actions or call tools — your only job is to update the digest text.

# Previous digest
${digestBlock}

# New messages since last digest update
${messagesBlock || "(none)"}

# Output format (REQUIRED)
Respond with a single JSON object, no prose, no code fences:

{"digest": "<the new digest body, ${maxChars} chars max>", "intentShift": "<one-sentence summary of any intent shift, or empty string if none>"}

JSON:`;
}

export function parseIntentUpdateResponse(raw: string): {
  digest: string;
  intentShift: string;
} {
  const trimmed = raw.trim();

  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenceMatch ? fenceMatch[1]!.trim() : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const objectMatch = /\{[\s\S]*\}/.exec(candidate);
    if (!objectMatch) {
      throw new Error("castlegate: intent update response is not valid JSON");
    }
    parsed = JSON.parse(objectMatch[0]);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).digest !== "string"
  ) {
    throw new Error("castlegate: intent update response missing 'digest' string field");
  }

  const obj = parsed as Record<string, unknown>;
  return {
    digest: (obj.digest as string).trim(),
    intentShift: typeof obj.intentShift === "string" ? obj.intentShift.trim() : "",
  };
}

export function enforceMaxChars(digest: string, maxChars: number): string {
  if (maxChars <= 0 || digest.length <= maxChars) return digest;
  return digest.slice(0, maxChars);
}

export function configForPrompt(cfg: CastlegateConfig): {
  maxChars: number;
  compactThreshold: number;
  maxRecentMessages: number;
} {
  return {
    maxChars: cfg.intent.maxChars,
    compactThreshold: cfg.intent.compactThreshold,
    maxRecentMessages: cfg.intent.maxRecentMessages,
  };
}
