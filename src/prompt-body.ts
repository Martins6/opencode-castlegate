import type { CastlegateConfig } from "./config.ts";

export interface SidecarPromptBody {
  model?: { providerID: string; modelID: string };
  system: string;
  parts: Array<{ type: "text"; text: string }>;
}

const SYSTEM_PROMPT =
  "You are a precise, terse JSON-producing subagent. Respond only with the requested JSON, no preamble, no fences.";

export function buildSidecarPromptBody(
  cfg: CastlegateConfig,
  prompt: string,
): SidecarPromptBody {
  const body: SidecarPromptBody = {
    system: SYSTEM_PROMPT,
    parts: [{ type: "text", text: prompt }],
  };
  if (cfg.update.model) {
    const sep = cfg.update.model.indexOf("/");
    body.model = {
      providerID: cfg.update.model.slice(0, sep),
      modelID: cfg.update.model.slice(sep + 1),
    };
  }
  return body;
}