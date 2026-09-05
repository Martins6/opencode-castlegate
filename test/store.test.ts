import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as os from "node:os";
import { promises as fs } from "node:fs";
import {
  loadDigest,
  saveDigest,
  deleteDigest,
  sanitizeId,
  needsCompact,
  digestPath,
} from "../src/store.ts";

async function mkTmpDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "castlegate-test-"));
}

test("sanitizeId replaces unsafe characters", () => {
  assert.equal(sanitizeId("abc/def:123"), "abc_def_123");
  assert.equal(sanitizeId("../../../etc/passwd"), ".._.._.._etc_passwd");
});

test("needsCompact triggers at threshold", () => {
  assert.equal(needsCompact("a".repeat(800), 1000, 0.8), true);
  assert.equal(needsCompact("a".repeat(799), 1000, 0.8), false);
  assert.equal(needsCompact("", 1000, 0.8), false);
});

test("digestPath returns a sanitized filename in the dir", () => {
  const p = digestPath("/tmp/x", "sess/abc");
  assert.equal(p, path.join("/tmp/x", "sess_abc.md"));
});

test("saveDigest then loadDigest round-trips body and metadata", async () => {
  const dir = await mkTmpDir();
  try {
    const header = await saveDigest(dir, "sess1", "anchor: ship the gate", {
      lastMessageId: "msg_001",
    });
    assert.equal(header.digestVersion, 1);
    assert.equal(header.lastMessageId, "msg_001");
    assert.equal(header.charCount, "anchor: ship the gate".length);

    const file = await loadDigest(dir, "sess1");
    assert.ok(file, "file should load");
    assert.equal(file.body, "anchor: ship the gate");
    assert.equal(file.header.digestVersion, 1);
    assert.equal(file.header.lastMessageId, "msg_001");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("saveDigest increments version on each save", async () => {
  const dir = await mkTmpDir();
  try {
    const h1 = await saveDigest(dir, "s1", "v1 body");
    const h2 = await saveDigest(dir, "s1", "v2 body");
    const h3 = await saveDigest(dir, "s1", "v3 body");
    assert.equal(h1.digestVersion, 1);
    assert.equal(h2.digestVersion, 2);
    assert.equal(h3.digestVersion, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadDigest returns null when file does not exist", async () => {
  const dir = await mkTmpDir();
  try {
    const file = await loadDigest(dir, "nope");
    assert.equal(file, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("deleteDigest removes the file and is idempotent", async () => {
  const dir = await mkTmpDir();
  try {
    await saveDigest(dir, "del", "x");
    await deleteDigest(dir, "del");
    assert.equal(await loadDigest(dir, "del"), null);
    await deleteDigest(dir, "del");
    assert.equal(await loadDigest(dir, "del"), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("atomic write does not leave a temp file behind", async () => {
  const dir = await mkTmpDir();
  try {
    await saveDigest(dir, "atomic", "hello");
    const entries = await fs.readdir(dir);
    const tmps = entries.filter((e) => e.endsWith(".tmp"));
    assert.equal(tmps.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
