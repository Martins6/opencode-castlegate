# SPEC — castlegate

## 1. Purpose

OpenCode plugin that gates tool calls against the user's stated session intent. A lightweight model maintains a rolling **intent digest** for the session. Each gated `tool.execute.before` call is validated against that digest:

- **Match** → tool runs (no user prompt).
- **Mismatch** → tool is blocked with a tagged error; the main agent surfaces the request to the user via its `question` tool.

## 2. Non-goals

- Not a sandbox. castlegate does not enforce OS-level isolation.
- Not a static permission system. OpenCode's `permission` config handles pattern rules.
- Not a replacement for the user's own judgment. The user can always say "yes" via the question tool.

## 3. Architecture

```
              ┌────────────────────────────────────────────────┐
              │                Plugin runtime                   │
              │                                                │
              │   event hook                                    │
              │     └─► session.created    → seed digest file   │
              │     └─► message.updated   → schedule digest    │
              │                          update (1s debounce)  │
              │     └─► session.deleted   → drop digest file   │
              │                                                │
              │   tool.execute.before                          │
              │     └─► shouldValidate(tool, cfg)               │
              │     └─► loadDigest(dir, sessionId)             │
              │     └─► validateToolCall(...) ←─ LLM call      │
              │     └─► match: allow | mismatch: throw tagged  │
              │                                                │
              │   tool.intent_context (custom)                  │
              │     └─► returns current digest for the session │
              │                                                │
              │   dispose                                       │
              │     └─► cancel timers, clear validator cache   │
              └────────────────────────────────────────────────┘
                              │                  │
                              ▼                  ▼
              .opencode/intent/<sid>.md    Sidecar session
              (on-disk digest, atomic)     (validator LLM calls)
```

### 3.1 Sidecar session

The validator LLM runs in a hidden, persistent opencode session created via `client.session.create({body: {title: "[castlegate] validator sidecar"}})`. This keeps validator calls out of the user's session history and amortizes session setup. One sidecar per plugin instance.

### 3.2 Storage format

`.opencode/intent/<sanitizedSessionId>.md`:

```
---
digestVersion: 4
lastMessageId: msg_41
updatedAt: 2026-09-05T12:00:00.000Z
charCount: 612
---

<markdown body, <= intent.maxChars>
```

Writes are atomic (temp file + `fs.rename`, with `fsync` of the temp file before the rename).

### 3.3 Validator cache

`validateToolCall` results are cached in-memory keyed by `sha256(tool + "\0" + JSON.stringify(args) + "\0" + digestVersion)` for `validate.cacheTtlMs`. Cache auto-invalidates when the digest version bumps (next `intent.updated`).

## 4. Public surface

### 4.1 Plugin entry

```ts
// src/index.ts
export const CastlegatePlugin: Plugin = async (input, options) => { ... };
export default CastlegatePlugin;
export { CastlegateIntentMismatchError, CASTLEGATE_TAG };
```

### 4.2 Custom tool

```
intent_context
  args: { format?: "summary" | "raw" }
  returns: { title, output, metadata: { version, lastMessageId, updatedAt, charCount } }
```

### 4.3 Tagged error

```ts
class CastlegateIntentMismatchError extends Error {
  readonly tag = "CASTLEGATE_INTENT_MISMATCH";
  readonly tool: string;
  readonly reason: string;
  readonly severity: "low" | "medium" | "high";
}
```

Error message format (must stay stable for the main agent to parse):

```
CASTLEGATE_INTENT_MISMATCH: tool '<name>' did not match the current session intent.
Reason: <reason>
Severity: <severity>
Action required: surface this to the user via the question tool and wait for explicit approval before retrying the tool call.
```

### 4.4 Config

See `docs/config.md`. The plugin is loaded as `opencode-castlegate` and its options use the top-level `opencode-castlegate` key in `opencode.json`.

## 5. Behavioral contracts

### 5.1 What `shouldValidate` returns

| Condition | Result |
|---|---|
| `tool` ∈ `validate.skip` | `false` (skip) |
| `validate.tools` set and `tool` ∉ `validate.tools` | `false` (skip) |
| otherwise | `true` |

### 5.2 What the validator returns

```json
{ "match": <bool>, "reason": <string>, "severity": "low" | "medium" | "high" }
```

Parsed from the lightweight model's text response. Accepts fenced JSON, surrounding prose, or plain JSON. Defaults severity to `medium` on unrecognized values.

### 5.3 What happens on mismatch when `requireApprovalOnMismatch: true`

`CastlegateIntentMismatchError` is thrown from `tool.execute.before`. OpenCode converts this to a tool error for the agent. The bash command never executes. The agent is expected to call its `question` tool with a yes/no/always choice.

### 5.4 What happens on validator failure (`failOpenOnError`)

| `failOpenOnError` | Behavior |
|---|---|
| `true` (default) | Log warning, allow tool call |
| `false` | Throw `CastlegateIntentMismatchError` with severity `medium` (or `high` for `bash`) |

### 5.5 What happens when no digest exists yet

`validate.skip_no_digest` is logged and the tool call is allowed through. The intent ingestion loop will populate the digest before the next gated tool call (1s debounce).

## 6. Lifecycle

| Event | Handler |
|---|---|
| `session.created` | Initialize empty digest file (`digestVersion: 1`, body `""`) |
| `message.updated` | Debounce 1s, then `updateDigest` |
| `message.part.updated` / `message.part.removed` / `message.removed` | Same debounced path |
| `session.deleted` | Delete digest file, drop per-session state |
| `dispose()` | Cancel timers, clear cache |

## 7. Logging

All events flow through `client.app.log` with `service: "castlegate"`. Tool argument values are never logged; only the keys (e.g. `["command"]`) and the validator's reason string. See `docs/security-model.md` for the full event list.

## 8. Failure modes

| Mode | Symptom | Mitigation |
|---|---|---|
| Lightweight model call throws | `validate.error` event; `failOpenOnError` decides outcome | Configurable |
| Lightweight model returns invalid JSON | parser throws → treated as validator error | Same |
| Digest file corrupted | `loadDigest` returns `null` → treated as no digest → tool allowed | Atomic writes + version field help detect corruption; future: checksum |
| Two updates race | Last write wins (atomic rename) | Acceptable; digest version makes stale reads detectable |
| Opencode kills the sidecar session | Next validator call creates a fresh one (cache holds the stale id but call errors) | Acceptable; fallback decision applies |

## 9. Future work

- Decision journal: persist user-approved exceptions so the validator does not re-block after explicit approval.
- Heuristic-only mode (`validate.mode: "heuristic"`) for zero-cost validation against the digest.
- Compaction hook integration so the digest survives long sessions without losing the anchor intent.
- Native `permission.ask` API integration once upstream issues #37164 / #34327 land.

## 10. Compatibility

- opencode ≥ 1.0 (uses `@opencode-ai/plugin` ≥ 1.18.0, SDK ≥ 1.18.0)
- zod 4.1.x (locked; newer minor versions change the `_zod.version.minor` tag and break `tool()` typings)
- Node ≥ 20 for development (type-check, tests). Runtime is bun, shipped via opencode.
