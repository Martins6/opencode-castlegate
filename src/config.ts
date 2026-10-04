import { z } from "zod";

export const ModelConfigSchema = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const IntentConfigSchema = z.object({
  maxChars: z.number().int().positive().default(4000),
  compactThreshold: z.number().min(0.1).max(1).default(0.8),
  maxRecentMessages: z.number().int().positive().default(20),
});
export type IntentConfig = z.infer<typeof IntentConfigSchema>;

export const ValidateConfigSchema = z.object({
  tools: z.array(z.string()).optional(),
  skip: z.array(z.string()).default([]),
  requireApprovalOnMismatch: z.boolean().default(true),
  failOpenOnError: z.boolean().default(true),
  cacheTtlMs: z.number().int().nonnegative().default(30_000),
  mode: z.enum(["llm", "heuristic", "both"]).default("llm"),
});
export type ValidateConfig = z.infer<typeof ValidateConfigSchema>;

export const StorageConfigSchema = z.object({
  directory: z.string().default(".opencode/intent"),
});
export type StorageConfig = z.infer<typeof StorageConfigSchema>;

export const CastlegateConfigSchema = z.object({
  model: ModelConfigSchema.optional(),
  intent: IntentConfigSchema.default(() => ({
    maxChars: 4000,
    compactThreshold: 0.8,
    maxRecentMessages: 20,
  })),
  validate: ValidateConfigSchema.default(() => ({
    skip: [],
    requireApprovalOnMismatch: true,
    failOpenOnError: true,
    cacheTtlMs: 30_000,
    mode: "llm" as const,
  })),
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
