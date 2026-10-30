/**
 * Structured logging (SPEC §7).
 *
 * V2 has no `app.log` write API (ctx.app is name/version/channel only), so
 * events go to the host log as one JSON line per event on stdout/stderr with
 * the `service: "castlegate"` tag. Tool argument VALUES are never logged —
 * only their keys (redactedArgKeys).
 */

import type { CastlegateConfig } from "./config.ts";

export interface Logger {
  event(name: string, fields?: Record<string, unknown>): Promise<void>;
  warn(name: string, fields?: Record<string, unknown>): Promise<void>;
  error(name: string, fields?: Record<string, unknown>): Promise<void>;
}

export function redactedArgKeys(args: unknown): string[] {
  if (args === null || typeof args !== "object") return [];
  return Object.keys(args as Record<string, unknown>);
}

function emit(level: "info" | "warn" | "error", name: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ service: "castlegate", level, event: name, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(cfg: CastlegateConfig): Logger {
  return {
    async event(name, fields = {}) {
      if (cfg.logging) emit("info", name, fields);
    },
    async warn(name, fields = {}) {
      if (cfg.logging) emit("warn", name, fields);
    },
    async error(name, fields = {}) {
      emit("error", name, fields); // errors are always logged
    },
  };
}
