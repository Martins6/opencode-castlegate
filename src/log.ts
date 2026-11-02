/**
 * Structured logging (SPEC §7).
 *
 * V2 has no `app.log` write API (ctx.app is name/version/channel only), so
 * events are emitted as one JSON line per event to two sinks:
 *
 *   * stderr — the host log captures stderr in every mode, and
 *   * <storage.directory>/castlegate.log — the same line, persisted, so the
 *     event stream survives even when stderr never reaches opencode.log.
 *
 * Every line carries `ts` (ISO timestamp) and `pid` so events from concurrent
 * processes can be told apart and ordered after the fact. Tool argument VALUES
 * are never logged — only their keys (redactedArgKeys).
 *
 * Logging must never throw or break the plugin: a broken file sink degrades to
 * stderr-only after a single `log.file_unavailable` warning.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
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

/** Path of the persistent event stream inside the storage directory. */
export function logFilePath(directory: string): string {
  return path.join(directory, "castlegate.log");
}

/** One JSON line per event: timestamped, tagged, fields spread last. */
export function serializeEvent(
  level: "info" | "warn" | "error",
  name: string,
  fields: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    service: "castlegate",
    level,
    event: name,
    ...fields,
  });
}

let fileSinkFailed = false;

/**
 * Append a serialized event line to the persistent log. Never throws; on the
 * first failure it warns once on stderr and stays quiet until a write succeeds
 * again.
 */
export async function appendLogLine(directory: string, serialized: string): Promise<void> {
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.appendFile(logFilePath(directory), `${serialized}\n`, "utf8");
    fileSinkFailed = false;
  } catch (err) {
    if (!fileSinkFailed) {
      fileSinkFailed = true;
      console.error(
        serializeEvent("warn", "log.file_unavailable", {
          path: logFilePath(directory),
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}

export function createLogger(cfg: CastlegateConfig, directory: string): Logger {
  // stderr only for the host log: plugin stdout is not captured by the
  // opencode log in every mode, stderr is. The level travels in the payload.
  const emit = async (
    level: "info" | "warn" | "error",
    name: string,
    fields: Record<string, unknown>,
  ): Promise<void> => {
    const serialized = serializeEvent(level, name, fields);
    console.error(serialized);
    await appendLogLine(directory, serialized);
  };
  return {
    async event(name, fields = {}) {
      if (cfg.logging) await emit("info", name, fields);
    },
    async warn(name, fields = {}) {
      if (cfg.logging) await emit("warn", name, fields);
    },
    async error(name, fields = {}) {
      await emit("error", name, fields); // errors are always logged
    },
  };
}
