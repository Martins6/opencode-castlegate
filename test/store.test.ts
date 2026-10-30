import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadIntent,
  saveIntent,
  deleteIntent,
  reviveIntent,
  isTombstoned,
  needsCompact,
  intentPath,
  sanitizeId,
} from "../src/store.ts";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "castlegate-store-"));
}

test("sanitizeId blocks path traversal", () => {
  assert.equal(sanitizeId("../../../etc/passwd"), ".._.._.._etc_passwd");
  assert.equal(sanitizeId("ok.id-1_2"), "ok.id-1_2");
});

test("needsCompact triggers at threshold", () => {
  assert.equal(needsCompact("a".repeat(800), 1000, 0.8), true);
  assert.equal(needsCompact("a".repeat(799), 1000, 0.8), false);
  assert.equal(needsCompact("", 1000, 0.8), false);
});

test("intentPath returns a sanitized filename in the dir", () => {
  const p = intentPath("/tmp/x", "sess/abc");
  assert.equal(p, path.join("/tmp/x", "sess_abc.md"));
});

test("saveIntent then loadIntent round-trips body and metadata", async () => {
  const dir = await tmpDir();
  const result = await saveIntent(dir, "sess1", "anchor: ship the gate", {
    expectedVersion: 0,
    lastMessageId: "msg_1",
  });
  assert.equal(result.saved, true);
  if (result.saved) {
    assert.equal(result.header.intentVersion, 1);
    assert.equal(result.header.lastMessageId, "msg_1");
    assert.equal(result.header.charCount, "anchor: ship the gate".length);
  }

  const file = await loadIntent(dir, "sess1");
  assert.ok(file);
  assert.equal(file.header.intentVersion, 1);
  assert.equal(file.body, "anchor: ship the gate");
});

test("saveIntent increments intentVersion on each save", async () => {
  const dir = await tmpDir();
  const h1 = await saveIntent(dir, "s1", "v1 body", { expectedVersion: 0 });
  const h2 = await saveIntent(dir, "s1", "v2 body", { expectedVersion: 1 });
  const h3 = await saveIntent(dir, "s1", "v3 body", { expectedVersion: 2 });
  assert.ok(h1.saved && h2.saved && h3.saved);
  if (h1.saved && h2.saved && h3.saved) {
    assert.equal(h1.header.intentVersion, 1);
    assert.equal(h2.header.intentVersion, 2);
    assert.equal(h3.header.intentVersion, 3);
  }
});

test("saveIntent discards a stale draft (CAS version_conflict)", async () => {
  const dir = await tmpDir();
  await saveIntent(dir, "cas", "newer intent", { expectedVersion: 0 });

  // A draft based on a version that no longer matches must not clobber.
  const stale = await saveIntent(dir, "cas", "stale draft", { expectedVersion: 0 });
  assert.equal(stale.saved, false);
  if (!stale.saved && stale.reason === "version_conflict") {
    assert.equal(stale.currentVersion, 1);
  }

  const file = await loadIntent(dir, "cas");
  assert.ok(file);
  assert.equal(file.body, "newer intent");
  assert.equal(file.header.intentVersion, 1);
});

test("saveIntent CAS compares against the version the draft was based on", async () => {
  const dir = await tmpDir();
  await saveIntent(dir, "cas2", "one", { expectedVersion: 0 });
  await saveIntent(dir, "cas2", "two", { expectedVersion: 1 });

  const ok = await saveIntent(dir, "cas2", "three", { expectedVersion: 2 });
  assert.equal(ok.saved, true);
  const stale = await saveIntent(dir, "cas2", "four", { expectedVersion: 2 });
  assert.equal(stale.saved, false);
});

test("loadIntent returns null when file does not exist", async () => {
  const dir = await tmpDir();
  const file = await loadIntent(dir, "nope");
  assert.equal(file, null);
});

test("deleteIntent removes the file, is idempotent, and tombstones the session", async () => {
  const dir = await tmpDir();
  await saveIntent(dir, "del", "x", { expectedVersion: 0 });
  await deleteIntent(dir, "del");
  assert.equal(await loadIntent(dir, "del"), null);
  assert.equal(isTombstoned(dir, "del"), true);
  await deleteIntent(dir, "del");
  assert.equal(await loadIntent(dir, "del"), null);
});

test("saveIntent after deleteIntent refuses to resurrect (tombstoned)", async () => {
  const dir = await tmpDir();
  await saveIntent(dir, "gone", "x", { expectedVersion: 0 });
  await deleteIntent(dir, "gone");

  const result = await saveIntent(dir, "gone", "resurrect", { expectedVersion: 0 });
  assert.equal(result.saved, false);
  if (!result.saved) assert.equal(result.reason, "tombstoned");
  assert.equal(await loadIntent(dir, "gone"), null);
});

test("reviveIntent clears the tombstone so a new session can save again", async () => {
  const dir = await tmpDir();
  await saveIntent(dir, "re", "x", { expectedVersion: 0 });
  await deleteIntent(dir, "re");
  reviveIntent(dir, "re");
  assert.equal(isTombstoned(dir, "re"), false);

  const result = await saveIntent(dir, "re", "fresh", { expectedVersion: 0 });
  assert.equal(result.saved, true);
  const file = await loadIntent(dir, "re");
  assert.equal(file?.body, "fresh");
});

test("saveIntent is atomic: no .tmp files left behind", async () => {
  const dir = await tmpDir();
  await saveIntent(dir, "atomic", "hello", { expectedVersion: 0 });
  const entries = await fs.readdir(dir);
  assert.equal(entries.some((e) => e.endsWith(".tmp")), false);
  assert.ok(entries.includes("atomic.md"));
});

test("concurrent saves serialize: exactly one CAS wins", async () => {
  const dir = await tmpDir();
  await saveIntent(dir, "race", "base", { expectedVersion: 0 });

  const results = await Promise.all([
    saveIntent(dir, "race", "draft-a", { expectedVersion: 1 }),
    saveIntent(dir, "race", "draft-b", { expectedVersion: 1 }),
    saveIntent(dir, "race", "draft-c", { expectedVersion: 1 }),
  ]);
  const wins = results.filter((r) => r.saved);
  assert.equal(wins.length, 1);

  const file = await loadIntent(dir, "race");
  assert.ok(file);
  assert.equal(file.header.intentVersion, 2);
});
