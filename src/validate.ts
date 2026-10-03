import { createHash } from "node:crypto";
import type { PluginInput } from "@opencode-ai/plugin";
import type { CastlegateConfig } from "./config.ts";
import {
  buildIntentValidatePrompt,
  parseIntentValidateResponse,
  summarizeArgs,
  type IntentValidateResult,
} from "./prompts/intent-validate.ts";
import { buildSidecarPromptBody } from "./prompt-body.ts";

type PluginClient = PluginInput["client"];

export interface ValidateToolCallArgs {
  client: PluginClient;
  cfg: CastlegateConfig;
  digest: string;
  digestVersion: number;
  tool: string;
  callArgs: unknown;
  sidecar: { id: string | null; pending: Promise<string> | null };
}

export interface ValidatorDecision {
  result: IntentValidateResult;
  cached: boolean;
}

interface CacheEntry {
  result: IntentValidateResult;
  expiresAt: number;
}

const cacheState = new Map<string, CacheEntry>();

function cacheKey(tool: string, args: unknown, digestVersion: number): string {
  const argsStr = (() => {
    try {
      return JSON.stringify(args);
    } catch {
      return String(args);
    }
  })();
  return createHash("sha256")
    .update(tool)
    .update("\u0000")
    .update(argsStr)
    .update("\u0000")
    .update(String(digestVersion))
    .digest("hex");
}

function cacheGet(key: string, ttlMs: number): IntentValidateResult | null {
  if (ttlMs <= 0) return null;
  const entry = cacheState.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cacheState.delete(key);
    return null;
  }
  return entry.result;
}

function cachePut(key: string, result: IntentValidateResult, ttlMs: number): void {
  if (ttlMs <= 0) return;
  cacheState.set(key, { result, expiresAt: Date.now() + ttlMs });
}

export function clearValidatorCache(): void {
  cacheState.clear();
}

export function shouldValidate(tool: string, cfg: CastlegateConfig): boolean {
  if (cfg.validate.skip.includes(tool)) return false;
  if (cfg.validate.tools && cfg.validate.tools.length > 0) {
    return cfg.validate.tools.includes(tool);
  }
  return true;
}

async function ensureSidecar(client: PluginClient): Promise<string> {
  const created = await client.session.create({
    body: { title: "[castlegate] validator sidecar" },
  });
  if (!created.data) throw new Error("castlegate: failed to create validator sidecar session");
  return created.data.id;
}

async function getSidecarId(
  client: PluginClient,
  sidecar: { id: string | null; pending: Promise<string> | null },
): Promise<string> {
  if (sidecar.id) return sidecar.id;
  if (!sidecar.pending) {
    sidecar.pending = ensureSidecar(client).then((id) => {
      sidecar.id = id;
      return id;
    });
  }
  return sidecar.pending;
}

async function callValidator(
  client: PluginClient,
  sidecarId: string,
  cfg: CastlegateConfig,
  prompt: string,
): Promise<string> {
  const result = await client.session.prompt({
    path: { id: sidecarId },
    body: buildSidecarPromptBody(cfg, prompt),
  });

  const parts = result.data?.parts ?? [];
  return parts
    .map((p: { type?: string; text?: string }) => {
      if (p.type === "text" && typeof p.text === "string") return p.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function validateToolCall(args: ValidateToolCallArgs): Promise<ValidatorDecision> {
  const { client, cfg, digest, digestVersion, tool, callArgs, sidecar } = args;

  const key = cacheKey(tool, callArgs, digestVersion);
  const cached = cacheGet(key, cfg.validate.cacheTtlMs);
  if (cached) return { result: cached, cached: true };

  const argsSummary = summarizeArgs(tool, callArgs);
  const prompt = buildIntentValidatePrompt({ digest, tool, argsSummary });
  const sidecarId = await getSidecarId(client, sidecar);
  const raw = await callValidator(client, sidecarId, cfg, prompt);
  const result = parseIntentValidateResponse(raw);

  cachePut(key, result, cfg.validate.cacheTtlMs);
  return { result, cached: false };
}

export function fallbackDecision(tool: string, cfg: CastlegateConfig): IntentValidateResult {
  if (cfg.validate.failOpenOnError) {
    return { match: true, reason: "validator unavailable (fail-open)", severity: "low" };
  }
  return {
    match: false,
    reason: "validator unavailable (fail-closed)",
    severity: tool === "bash" ? "high" : "medium",
  };
}
