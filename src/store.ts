import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface IntentHeader {
  intentVersion: number;
  lastMessageId: string | null;
  updatedAt: string;
  charCount: number;
}

export interface IntentFile {
  header: IntentHeader;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function nowIso(): string {
  return new Date().toISOString();
}

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

export function intentPath(dir: string, sessionId: string): string {
  return path.join(dir, `${sanitizeId(sessionId)}.md`);
}

export function needsCompact(body: string, maxChars: number, threshold: number): boolean {
  if (maxChars <= 0) return false;
  return body.length >= Math.floor(maxChars * threshold);
}

function parseFrontmatter(raw: string): IntentFile | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;

  const fmBlock = match[1] ?? "";
  const body = match[2] ?? "";

  const header: Partial<IntentHeader> = {};
  for (const line of fmBlock.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === "intentVersion") {
      const n = Number(value);
      if (Number.isFinite(n)) header.intentVersion = n;
    } else if (key === "lastMessageId") {
      header.lastMessageId = value === "" || value === "null" ? null : value;
    } else if (key === "updatedAt") {
      header.updatedAt = value;
    } else if (key === "charCount") {
      const n = Number(value);
      if (Number.isFinite(n)) header.charCount = n;
    }
  }

  if (
    typeof header.intentVersion !== "number" ||
    typeof header.updatedAt !== "string" ||
    typeof header.charCount !== "number"
  ) {
    return null;
  }

  return {
    header: header as IntentHeader,
    body,
  };
}

function serialize(header: IntentHeader, body: string): string {
  const fm = [
    "---",
    `intentVersion: ${header.intentVersion}`,
    `lastMessageId: ${header.lastMessageId ?? "null"}`,
    `updatedAt: ${header.updatedAt}`,
    `charCount: ${header.charCount}`,
    "---",
    "",
  ].join("\n");
  return `${fm}${body}`;
}

export async function loadIntent(dir: string, sessionId: string): Promise<IntentFile | null> {
  try {
    const raw = await fs.readFile(intentPath(dir, sessionId), "utf8");
    return parseFrontmatter(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface SaveIntentOptions {
  /**
   * CAS guard: the intentVersion this draft is based on (0 = expect no file).
   * A mismatch discards the draft instead of clobbering a newer intent.
   */
  expectedVersion: number;
  lastMessageId?: string | null;
}

export type SaveIntentResult =
  | { saved: true; header: IntentHeader }
  | { saved: false; reason: "version_conflict"; currentVersion: number }
  | { saved: false; reason: "tombstoned" };

// Per-key write serialization so the check-then-write of the CAS is atomic
// within the process. Cross-process races still resolve by atomic rename.
const writeChains = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  writeChains.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

// Tombstones: a deleted session must not be resurrected by an in-flight save.
const tombstones = new Set<string>();

function stateKey(dir: string, sessionId: string): string {
  return `${dir}\0${sessionId}`;
}

export function isTombstoned(dir: string, sessionId: string): boolean {
  return tombstones.has(stateKey(dir, sessionId));
}

/** Clear the tombstone for a (re)created session. */
export function reviveIntent(dir: string, sessionId: string): void {
  tombstones.delete(stateKey(dir, sessionId));
}

export async function saveIntent(
  dir: string,
  sessionId: string,
  body: string,
  opts: SaveIntentOptions,
): Promise<SaveIntentResult> {
  return withLock(stateKey(dir, sessionId), async () => {
    if (isTombstoned(dir, sessionId)) return { saved: false, reason: "tombstoned" };

    const current = await loadIntent(dir, sessionId);
    const currentVersion = current?.header.intentVersion ?? 0;
    if (currentVersion !== opts.expectedVersion) {
      return { saved: false, reason: "version_conflict", currentVersion };
    }

    await fs.mkdir(dir, { recursive: true });

    const header: IntentHeader = {
      intentVersion: currentVersion + 1,
      lastMessageId: opts.lastMessageId ?? current?.header.lastMessageId ?? null,
      updatedAt: nowIso(),
      charCount: body.length,
    };

    const file = intentPath(dir, sessionId);
    const tmp = path.join(
      dir,
      `.${sanitizeId(sessionId)}.${process.pid}.${Date.now()}.tmp`,
    );

    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(serialize(header, body), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(tmp, file);
    return { saved: true, header };
  });
}

export async function deleteIntent(dir: string, sessionId: string): Promise<void> {
  tombstones.add(stateKey(dir, sessionId));
  await withLock(stateKey(dir, sessionId), async () => {
    try {
      await fs.unlink(intentPath(dir, sessionId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  });
}

export function resolveStorageDir(directory: string, storageDir: string): string {
  if (path.isAbsolute(storageDir)) return storageDir;
  return path.resolve(directory, storageDir);
}
