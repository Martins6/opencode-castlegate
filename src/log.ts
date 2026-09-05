import type { PluginInput } from "@opencode-ai/plugin";
import type { CastlegateConfig } from "./config.ts";

type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  event(name: string, fields: Record<string, unknown>): Promise<void>;
  warn(name: string, fields: Record<string, unknown>): Promise<void>;
  error(name: string, fields: Record<string, unknown>): Promise<void>;
}

export function createLogger(client: PluginInput["client"], cfg: CastlegateConfig): Logger {
  const send = async (level: LogLevel, name: string, fields: Record<string, unknown>) => {
    if (!cfg.logging && level !== "error") return;
    try {
      await client.app.log({
        body: {
          service: "castlegate",
          level,
          message: name,
          extra: fields,
        },
      });
    } catch {
      // never let logging break the plugin
    }
  };

  return {
    async event(name, fields) {
      await send("info", name, fields);
    },
    async warn(name, fields) {
      await send("warn", name, fields);
    },
    async error(name, fields) {
      await send("error", name, fields);
    },
  };
}

export function redactedArgKeys(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  try {
    return Object.keys(args as Record<string, unknown>);
  } catch {
    return [];
  }
}

export function previewArgValue(value: unknown, maxLen = 80): string {
  if (value == null) return String(value);
  if (typeof value === "string") {
    return value.length <= maxLen ? value : value.slice(0, maxLen) + "...";
  }
  try {
    const s = JSON.stringify(value);
    return s.length <= maxLen ? s : s.slice(0, maxLen) + "...";
  } catch {
    return "(unserializable)";
  }
}
