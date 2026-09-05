export interface IntentValidatePromptArgs {
  digest: string;
  tool: string;
  argsSummary: string;
}

export function buildIntentValidatePrompt(args: IntentValidatePromptArgs): string {
  const { digest, tool, argsSummary } = args;

  return `You are the castlegate intent validator. Decide whether a proposed tool call matches the user's stated session intent.

# User intent digest
${digest || "(no digest yet — answer conservatively, prefer mismatch)"}

# Proposed tool call
- Tool: ${tool}
- Arguments: ${argsSummary}

# Decision rules
- "match" = the call directly advances, supports, or is a routine side-effect of the intent in the digest.
- "mismatch" = the call is unrelated, contradicts, or exceeds the scope of the stated intent.
- When in doubt, prefer mismatch and assign severity "medium".
- Severity: "low" (mismatch but reversible + low blast radius), "medium" (file writes, network, install), "high" (destructive, irreversible, secret-bearing).

# Output format (REQUIRED)
Respond with a single JSON object, no prose, no fences:

{"match": <bool>, "reason": "<short rationale>", "severity": "low" | "medium" | "high"}

JSON:`;
}

export interface IntentValidateResult {
  match: boolean;
  reason: string;
  severity: "low" | "medium" | "high";
}

export function parseIntentValidateResponse(raw: string): IntentValidateResult {
  const trimmed = raw.trim();

  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenceMatch ? fenceMatch[1]!.trim() : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const objectMatch = /\{[\s\S]*?\}/.exec(candidate);
    if (!objectMatch) {
      throw new Error("castlegate: validator response is not valid JSON");
    }
    parsed = JSON.parse(objectMatch[0]);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("castlegate: validator response is not a JSON object");
  }

  const obj = parsed as Record<string, unknown>;
  const match = obj.match;
  if (typeof match !== "boolean") {
    throw new Error("castlegate: validator response missing boolean 'match'");
  }

  const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
  let severity: "low" | "medium" | "high" = "medium";
  if (obj.severity === "low" || obj.severity === "medium" || obj.severity === "high") {
    severity = obj.severity;
  }

  return { match, reason, severity };
}

export function summarizeArgs(tool: string, args: unknown): string {
  if (args === undefined || args === null) return "(no arguments)";
  try {
    let raw = "";
    if (typeof args === "string") raw = args;
    else raw = JSON.stringify(args);

    if (raw.length <= 1200) return raw;

    if (tool === "bash" && typeof args === "object" && args !== null) {
      const cmd = (args as Record<string, unknown>).command;
      if (typeof cmd === "string") {
        return JSON.stringify({ command: cmd.length > 1200 ? cmd.slice(0, 1200) + "..." : cmd });
      }
    }
    if (tool === "read" && typeof args === "object" && args !== null) {
      const fp = (args as Record<string, unknown>).filePath;
      if (typeof fp === "string") return JSON.stringify({ filePath: fp });
    }
    if (tool === "edit" && typeof args === "object" && args !== null) {
      const fp = (args as Record<string, unknown>).filePath;
      if (typeof fp === "string") return JSON.stringify({ filePath: fp });
    }
    if (tool === "webfetch" && typeof args === "object" && args !== null) {
      const url = (args as Record<string, unknown>).url;
      if (typeof url === "string") return JSON.stringify({ url });
    }
    return raw.slice(0, 1200) + "...";
  } catch {
    return "(unserializable arguments)";
  }
}
