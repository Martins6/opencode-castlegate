import { z } from "zod";

export const DecisionConfigSchema = z.object({
  // System One decision model server (llama.cpp llama-server or llama.app with
  // a d1-family model). NO default: the user must set up a decision server
  // consciously — without one, gated calls throw CASTLEGATE_DECISION_SERVER_NOT_FOUND.
  baseURL: z.string().min(1).optional(),
  model: z.string().min(1).optional(), // required by multi-model servers (e.g. llama.app); ignored by single-model ones
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
  // "auto" = question flow, degrades to steering when headless (SPEC §3.6)
  // | "headless" = steering error from block #1
  mode: z.enum(["auto", "headless"]).default("auto"),
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
  // Gated call before the intent exists: "block" fails closed with
  // CASTLEGATE_NO_INTENT (SPEC §5.5); "allow" restores the legacy pass-through.
  onMissingIntent: z.enum(["block", "allow"]).default("block"),
  noIntentRetrySeconds: z.number().int().positive().default(60),
  noIntentMaxAttempts: z.number().int().positive().default(3),
  cacheTtlMs: z.number().int().nonnegative().default(30_000),
});
export type ValidateConfig = z.infer<typeof ValidateConfigSchema>;

export const DEFAULT_STORAGE_DIR = ".opencode/intent";

export const StorageConfigSchema = z.object({
  directory: z.string().default(DEFAULT_STORAGE_DIR),
});
export type StorageConfig = z.infer<typeof StorageConfigSchema>;

export const CastlegateConfigSchema = z.object({
  enabled: z.boolean().default(true),
  decision: DecisionConfigSchema.default(() => ({
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
    mode: "auto" as const,
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
    onMissingIntent: "block" as const,
    noIntentRetrySeconds: 60,
    noIntentMaxAttempts: 3,
    cacheTtlMs: 30_000,
  })),
  retries: z.number().int().nonnegative().default(2),
  storage: StorageConfigSchema.default(() => ({ directory: DEFAULT_STORAGE_DIR })),
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
