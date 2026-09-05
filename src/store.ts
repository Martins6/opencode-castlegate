import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface DigestHeader {
  digestVersion: number;
  lastMessageId: string | null;
  updatedAt: string;
  charCount: number;
}

export interface DigestFile {
  header: DigestHeader;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function nowIso(): string {
  return new Date().toISOString();
}

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

export function digestPath(dir: string, sessionId: string): string {
  return path.join(dir, `${sanitizeId(sessionId)}.md`);
}

export function needsCompact(body: string, maxChars: number, threshold: number): boolean {
  if (maxChars <= 0) return false;
  return body.length >= Math.floor(maxChars * threshold);
}

function parseFrontmatter(raw: string): DigestFile | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;

  const fmBlock = match[1] ?? "";
  const body = match[2] ?? "";

  const header: Partial<DigestHeader> = {};
  for (const line of fmBlock.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === "digestVersion") {
      const n = Number(value);
      if (Number.isFinite(n)) header.digestVersion = n;
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
    typeof header.digestVersion !== "number" ||
    typeof header.updatedAt !== "string" ||
    typeof header.charCount !== "number"
  ) {
    return null;
  }

  return {
    header: header as DigestHeader,
    body,
  };
}

function serialize(header: DigestHeader, body: string): string {
  const fm = [
    "---",
    `digestVersion: ${header.digestVersion}`,
    `lastMessageId: ${header.lastMessageId ?? "null"}`,
    `updatedAt: ${header.updatedAt}`,
    `charCount: ${header.charCount}`,
    "---",
    "",
  ].join("\n");
  return `${fm}${body}`;
}

export async function loadDigest(dir: string, sessionId: string): Promise<DigestFile | null> {
  try {
    const raw = await fs.readFile(digestPath(dir, sessionId), "utf8");
    return parseFrontmatter(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface SaveOptions {
  baseVersion?: number;
  lastMessageId?: string | null;
}

export async function saveDigest(
  dir: string,
  sessionId: string,
  body: string,
  opts: SaveOptions = {},
): Promise<DigestHeader> {
  await fs.mkdir(dir, { recursive: true });

  const previous = await loadDigest(dir, sessionId);
  const header: DigestHeader = {
    digestVersion: (opts.baseVersion ?? previous?.header.digestVersion ?? 0) + 1,
    lastMessageId: opts.lastMessageId ?? previous?.header.lastMessageId ?? null,
    updatedAt: nowIso(),
    charCount: body.length,
  };

  const file = digestPath(dir, sessionId);
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
  return header;
}

export async function deleteDigest(dir: string, sessionId: string): Promise<void> {
  try {
    await fs.unlink(digestPath(dir, sessionId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function resolveStorageDir(directory: string, storageDir: string): string {
  if (path.isAbsolute(storageDir)) return storageDir;
  return path.resolve(directory, storageDir);
}

export function tmpPathFor(dir: string, sessionId: string): string {
  return path.join(
    dir,
    `.${sanitizeId(sessionId)}.${process.pid}.${Date.now()}.tmp`,
  );
}

export const _internal = {
  parseFrontmatter,
  serialize,
  os,
};
