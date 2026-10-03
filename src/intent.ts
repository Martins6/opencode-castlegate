import type { CastlegateConfig } from "./config.ts";
import { loadDigest, saveDigest, needsCompact, resolveStorageDir } from "./store.ts";
import {
  buildIntentUpdatePrompt,
  parseIntentUpdateResponse,
  enforceMaxChars,
} from "./prompts/intent-update.ts";
import { buildSidecarPromptBody } from "./prompt-body.ts";
import type { PluginInput } from "@opencode-ai/plugin";

type PluginClient = PluginInput["client"];

export interface UpdateDigestArgs {
  client: PluginClient;
  sessionId: string;
  cfg: CastlegateConfig;
  sinceMessageId?: string | null;
  newMessages?: Array<{ role: string; author?: string; text: string }>;
}

export interface UpdateDigestResult {
  digest: string;
  version: number;
  compacted: boolean;
  intentShift: string;
  skipped: boolean;
}

async function ensureSidecarSession(client: PluginClient): Promise<string> {
  const created = await client.session.create({
    body: { title: "[castlegate] validator sidecar" },
  });
  if (!created.data) {
    throw new Error("castlegate: failed to create sidecar session");
  }
  return created.data.id;
}

async function getSidecarId(
  client: PluginClient,
  cache: { id: string | null; pending: Promise<string> | null },
): Promise<string> {
  if (cache.id) return cache.id;
  if (!cache.pending) {
    cache.pending = ensureSidecarSession(client).then((id) => {
      cache.id = id;
      return id;
    });
  }
  return cache.pending;
}

export function createSidecar(): { id: string | null; pending: Promise<string> | null } {
  return { id: null, pending: null };
}

async function fetchRecentMessages(
  client: PluginClient,
  sessionId: string,
  sinceMessageId: string | null | undefined,
  limit: number,
): Promise<Array<{ id: string; role: string; author?: string; text: string }>> {
  const result = await client.session.messages({ path: { id: sessionId } });
  const data = result.data ?? [];
  const collected: Array<{ id: string; role: string; author?: string; text: string }> = [];
  let started = sinceMessageId == null;

  for (let i = data.length - 1; i >= 0 && collected.length < limit; i--) {
    const item = data[i]!;
    if (!started && item.info.id === sinceMessageId) {
      started = true;
      continue;
    }
    if (!started) continue;

    const role = (item.info as { role?: string }).role ?? "unknown";
    const author = (item.info as { agent?: string }).agent;

    const text = item.parts
      .map((p: { type?: string; text?: string }) => {
        const t = p.type;
        if (t === "text" && typeof p.text === "string") {
          return p.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");

    if (!text) continue;
    collected.push({ id: item.info.id, role, ...(author ? { author } : {}), text });
  }

  return collected.reverse();
}

async function callLightweightModel(
  client: PluginClient,
  sidecarId: string,
  cfg: CastlegateConfig,
  prompt: string,
): Promise<string> {
  const result = await client.session.prompt({
    path: { id: sidecarId },
    body: buildSidecarPromptBody(cfg, prompt),
  });

  const parts = result.data?.parts ?? [];
  const texts = parts
    .map((p: { type?: string; text?: string }) => {
      const t = p.type;
      if (t === "text" && typeof p.text === "string") {
        return p.text;
      }
      return "";
    })
    .filter(Boolean);
  return texts.join("\n").trim();
}

export async function updateDigest(
  args: UpdateDigestArgs,
  sidecar: ReturnType<typeof createSidecar>,
): Promise<UpdateDigestResult> {
  const { client, sessionId, cfg, sinceMessageId, newMessages } = args;
  const dir = resolveStorageDir(process.cwd(), cfg.storage.directory);
  const existing = await loadDigest(dir, sessionId);

  const freshMessages =
    newMessages ??
    (await fetchRecentMessages(
      client,
      sessionId,
      sinceMessageId ?? existing?.header.lastMessageId ?? null,
      cfg.intent.maxRecentMessages,
    ));

  if (freshMessages.length === 0 && existing) {
    return {
      digest: existing.body,
      version: existing.header.digestVersion,
      compacted: false,
      intentShift: "",
      skipped: true,
    };
  }

  if (freshMessages.length === 0 && !existing) {
    return {
      digest: "",
      version: 0,
      compacted: false,
      intentShift: "",
      skipped: true,
    };
  }

  const compact = existing
    ? needsCompact(existing.body, cfg.intent.maxChars, cfg.intent.compactThreshold)
    : false;

  const prompt = buildIntentUpdatePrompt({
    previousDigest: existing?.body ?? "",
    maxChars: cfg.intent.maxChars,
    newMessages: freshMessages.map((m) => ({
      role: m.role,
      ...(m.author ? { author: m.author } : {}),
      text: m.text,
    })),
    compact,
  });

  const sidecarId = await getSidecarId(client, sidecar);
  const raw = await callLightweightModel(client, sidecarId, cfg, prompt);
  const parsed = parseIntentUpdateResponse(raw);

  const safeDigest = enforceMaxChars(parsed.digest, cfg.intent.maxChars);
  const lastFresh = freshMessages[freshMessages.length - 1] as
    | { id: string; role: string; author?: string; text: string }
    | undefined;
  const lastId = lastFresh?.id ?? existing?.header.lastMessageId ?? null;
  const baseVersion = existing?.header.digestVersion ?? 0;

  const header = await saveDigest(dir, sessionId, safeDigest, {
    baseVersion,
    lastMessageId: lastId,
  });

  return {
    digest: safeDigest,
    version: header.digestVersion,
    compacted: compact,
    intentShift: parsed.intentShift,
    skipped: false,
  };
}
