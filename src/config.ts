import { z } from "zod";

export const DecisionConfigSchema = z.object({
  // System One decision model server (llama.cpp llama-server with the d1 GGUF)
  baseURL: z.string().min(1).default("http://127.0.0.1:8080/v1/systemone"),
  model: z.string().min(1).default("LiquidAI/d1-omni-600M-GGUF:Q8_0"), // ignored by single-model servers
  timeoutMs: z.number().int().positive().default(10_000),
  stateMaxChars: z.number().int().positive().default(8000),
  gateThreshold: z.number().min(0).max(1).default(0.5),
  safeConfidence: z.number().min(0).max(1).default(0.85),
});
export type DecisionConfig = z.infer<typeof DecisionConfigSchema>;

export const UpdateConfigSchema = z.object({
  // "providerID/modelID" override; null = the session's configured model
  model: z.string().min(1).nullable().default(null),
  timeoutMs: z.number().int().positive().default(60_000),
});
export type UpdateConfig = z.infer<typeof UpdateConfigSchema>;

export const ApprovalConfigSchema = z.object({
  absorbWaitSeconds: z.number().int().positive().default(60),
  replayTtlMs: z.number().int().positive().default(300_000),
});
export type ApprovalConfig = z.infer<typeof ApprovalConfigSchema>;

export const IntentConfigSchema = z.object({
  maxChars: z.number().int().positive().default(10_000),
  shrinkAttempts: z.number().int().positive().default(3),
  maxRecentMessages: z.number().int().positive().default(20),
});
export type IntentConfig = z.infer<typeof IntentConfigSchema>;

export const ValidateConfigSchema = z.object({
  tools: z.array(z.string()).default(["shell"]), // v2 tool name (v1: "bash")
  skip: z.array(z.string()).default([]),
  requireApprovalOnMismatch: z.boolean().default(true),
  onApiUnavailable: z.enum(["block", "allow"]).default("block"),
  cacheTtlMs: z.number().int().nonnegative().default(30_000),
});
export type ValidateConfig = z.infer<typeof ValidateConfigSchema>;

export const StorageConfigSchema = z.object({
  directory: z.string().default(".opencode/intent"),
});
export type StorageConfig = z.infer<typeof StorageConfigSchema>;

export const CastlegateConfigSchema = z.object({
  enabled: z.boolean().default(true),
  decision: DecisionConfigSchema.default(() => ({
    baseURL: "http://127.0.0.1:8080/v1/systemone",
    model: "LiquidAI/d1-omni-600M-GGUF:Q8_0",
    timeoutMs: 10_000,
    stateMaxChars: 8000,
    gateThreshold: 0.5,
    safeConfidence: 0.85,
  })),
  update: UpdateConfigSchema.default(() => ({
    model: null,
    timeoutMs: 60_000,
  })),
  approval: ApprovalConfigSchema.default(() => ({
    absorbWaitSeconds: 60,
    replayTtlMs: 300_000,
  })),
  intent: IntentConfigSchema.default(() => ({
    maxChars: 10_000,
    shrinkAttempts: 3,
    maxRecentMessages: 20,
  })),
  validate: ValidateConfigSchema.default(() => ({
    tools: ["shell"] as string[],
    skip: [] as string[],
    requireApprovalOnMismatch: true,
    onApiUnavailable: "block" as const,
    cacheTtlMs: 30_000,
  })),
  retries: z.number().int().nonnegative().default(2),
  storage: StorageConfigSchema.default(() => ({ directory: ".opencode/intent" })),
  logging: z.boolean().default(true),
});
export type CastlegateConfig = z.infer<typeof CastlegateConfigSchema>;

export function parseConfig(raw: unknown): CastlegateConfig {
  return CastlegateConfigSchema.parse(raw);
}

export function safeParseConfig(raw: unknown): {
  ok: true;
  config: CastlegateConfig;
} | {
  ok: false;
  error: z.ZodError;
} {
  const result = CastlegateConfigSchema.safeParse(raw);
  if (result.success) return { ok: true, config: result.data };
  return { ok: false, error: result.error };
}
