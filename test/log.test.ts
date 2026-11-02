import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendLogLine,
  createLogger,
  logFilePath,
  serializeEvent,
} from "../src/log.ts";
import { parseConfig } from "../src/config.ts";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "castlegate-log-"));
}

function cfg(overrides: Record<string, unknown> = {}) {
  return parseConfig(overrides);
}

async function readLines(dir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(logFilePath(dir), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => (console.error = original) };
}

test("logFilePath points at castlegate.log inside the storage dir", () => {
  assert.equal(logFilePath("/tmp/x"), path.join("/tmp/x", "castlegate.log"));
});

test("serializeEvent tags the line with ts, pid, service, level and event", () => {
  const line = serializeEvent("info", "gate.skip", { sessionID: "s1" });
  const rec = JSON.parse(line);
  assert.equal(rec.service, "castlegate");
  assert.equal(rec.level, "info");
  assert.equal(rec.event, "gate.skip");
  assert.equal(rec.sessionID, "s1");
  assert.equal(rec.pid, process.pid);
  assert.ok(!Number.isNaN(Date.parse(rec.ts)), "ts is an ISO timestamp");
});

test("createLogger persists every level to castlegate.log as JSONL", async () => {
  const dir = await tmpDir();
  const log = createLogger(cfg(), dir);
  await log.event("guard.allow", { sessionID: "s1", tool: "shell" });
  await log.warn("api.retry", { sessionID: "s1" });
  await log.error("api.unavailable", { sessionID: "s1" });

  const lines = await readLines(dir);
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => [l.level, l.event]),
    [
      ["info", "guard.allow"],
      ["warn", "api.retry"],
      ["error", "api.unavailable"],
    ],
  );
  assert.equal(lines[0]!.sessionID, "s1");
  assert.equal(lines[0]!.tool, "shell");
});

test("createLogger appends across calls instead of overwriting", async () => {
  const dir = await tmpDir();
  const log = createLogger(cfg(), dir);
  await log.event("gate.update");
  await createLogger(cfg(), dir).event("gate.skip");
  const lines = await readLines(dir);
  assert.deepEqual(
    lines.map((l) => l.event),
    ["gate.update", "gate.skip"],
  );
});

test("logging:false drops info and warn but keeps errors", async () => {
  const dir = await tmpDir();
  const log = createLogger(cfg({ logging: false }), dir);
  await log.event("guard.allow");
  await log.warn("api.retry");
  await log.error("guard.block");

  const lines = await readLines(dir);
  assert.deepEqual(
    lines.map((l) => l.event),
    ["guard.block"],
  );
});

test("appendLogLine creates missing directories", async () => {
  const dir = path.join(await tmpDir(), "nested", "storage");
  await appendLogLine(dir, serializeEvent("info", "plugin.setup"));
  const lines = await readLines(dir);
  assert.equal(lines[0]!.event, "plugin.setup");
});

test("appendLogLine never throws when the sink is unwritable and warns once", async () => {
  const file = path.join(await tmpDir(), "a-file");
  await fs.writeFile(file, "not a directory", "utf8");

  const capture = captureStderr();
  try {
    await appendLogLine(file, serializeEvent("info", "gate.skip"));
    await appendLogLine(file, serializeEvent("info", "gate.skip")); // second failure stays quiet
  } finally {
    capture.restore();
  }

  const warnings = capture.lines.map((l) => JSON.parse(l));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, "log.file_unavailable");
  assert.equal(warnings[0].level, "warn");

  // A successful write resets the warn-once latch.
  const dir = await tmpDir();
  await appendLogLine(dir, serializeEvent("info", "gate.skip"));
  const capture2 = captureStderr();
  try {
    await appendLogLine(file, serializeEvent("info", "gate.skip"));
  } finally {
    capture2.restore();
  }
  assert.equal(capture2.lines.length, 1);
});

test("createLogger resolves even when the file sink is broken", async () => {
  const file = path.join(await tmpDir(), "a-file");
  await fs.writeFile(file, "not a directory", "utf8");

  const capture = captureStderr();
  try {
    const log = createLogger(cfg(), file);
    await log.event("gate.skip");
    await log.error("guard.block");
  } finally {
    capture.restore();
  }
  // stderr still received both events (plus at most one file warning)
  const events = capture.lines.map((l) => JSON.parse(l).event);
  assert.ok(events.includes("gate.skip"));
  assert.ok(events.includes("guard.block"));
});
