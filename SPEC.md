# SPEC — castlegate

## 1. Purpose

OpenCode V2 plugin that gates `shell` tool calls against the user's stated session intent. A rolling **intent** is maintained per session by a three-node pipeline:

- **Gate** (decision model): decides *whether* new messages change the intent.
- **Update** (OpenCode's own model via `ctx.generate.text`): takes the current intent plus the user-message change and updates it **as it sees fit — an incremental edit or a full overwrite** — when the gate says yes, or folds in a user-approved clearance. **Only user-authored messages can change the intent** — assistant text, tool output, and file content never enter it. The approval path (§3.5) is the only other writer.
- **Guard** (decision model): decides *safe / not safe* for a proposed `shell` command against the intent.

Per gated tool call:

- **Safe** → tool runs (no user prompt).
- **Not safe** → tool is blocked with a tagged error; the main agent asks the user via its `question` tool. On approval, the clearance is absorbed into the intent so the same command (and close variants) is allowed from then on.

All binary decisions come from a **decision model** (LiquidAI **d1-omni-600M**, served by llama.cpp) that scores typed options and returns calibrated probabilities in one forward pass. There is **no JSON parsing on the decision path** — decisions are floats and typed option picks, never generated text. The only call that generates text is the intent update, and it runs on the user's own OpenCode model (`ctx.generate.text`). **No external LLM API and no API keys** — the only external component is the self-hosted decision server.

## 2. Non-goals

- Not a sandbox. castlegate does not enforce OS-level isolation.
- Not a static permission system. OpenCode's `permissions` config handles pattern rules.
- Not a replacement for the user's own judgment. The user can always say "yes".
- Not a JSON-enforcement layer. Decision nodes return typed answers; generated text is used only where free text is the product (the intent).
- Not an external-API client. No hosted LLM calls, no API keys, no Python server. The decision server is a self-hosted llama.cpp; the update node runs on the model OpenCode is already configured with.

## 3. Architecture

```
              ┌───────────────────────────────────────────────────────┐
              │             Plugin runtime (OpenCode V2)              │
              │                                                       │
              │  ctx.event.subscribe                                 │
              │    └─► session.created   → seed intent file           │
              │    └─► message.updated   → schedule intent update     │
              │         (1s debounce + in-flight coalescing)          │
              │         └─► GATE  → yes → UPDATE → save intent        │
              │                   → no  → intent untouched            │
              │    └─► session.deleted   → drop intent file           │
              │                                                       │
              │  ctx.tool.hook("execute.before")                      │
              │    └─► tool ∈ validate.tools (shell)?                 │
              │    └─► replay-cleared (§3.5)? → allow immediately     │
              │    └─► load intent → cache lookup                     │
              │    └─► GUARD → safe | not safe | api down             │
              │    └─► safe: allow                                    │
              │       not safe: CastlegateIntentMismatchError         │
              │        └─► agent asks user via question tool          │
              │              approve → absorb clearance (§3.5)        │
              │       api down:  CastlegateApiUnavailableError        │
              │                                                       │
              │  ctx.tool.hook("execute.after", question)             │
              │    └─► approved? → approvedAt timestamp + absorb      │
              │                                                       │
              │  ctx.tool.transform → intent_context tool             │
              │  setup() cleanup → cancel timers, clear caches        │
              └───────────────────────────────────────────────────────┘
                 │                │                     │
                 ▼                ▼                     ▼
        .opencode/intent/   Decision model server    OpenCode generation
        <sid>.md            (System One protocol)    (ctx.generate.text)
        atomic intent       llama.cpp: d1-omni-600M  the configured model
                            noul/choice/score →      applies one change to
                            typed probabilities      the intent; no external
                                                     API, no API key
```

### 3.1 Decision model server

The decision nodes talk to a **decision model server** over the System One protocol (`POST /v1/systemone`, llama.cpp PR #29818, shipped since llama.cpp b11361). The default model is **d1-omni-600M** (`LiquidAI/d1-omni-600M`) — a non-autoregressive decision model: given a *state* and *typed questions* (Decision Index schema), it returns typed answers with calibrated probabilities and confidence. It never generates text. The plugin is contract-conformant, not model-specific: **any decision model that matches the llama.cpp `/v1/systemone` contract works** — point `decision.baseURL` at the server and set `decision.model` accordingly. The contract is the requirement; d1-omni-600M is just the default and the model the test suite runs against.

Question types:

| Type | You send | You get |
|---|---|---|
| `noul` | a yes/no question | calibrated probability P(true) |
| `choice` | options with descriptions | top option + probability per option + confidence |
| `score` | 2–10 ordinal levels | expected level + distribution + confidence |

Multi-question batching evaluates all questions in **one forward pass**. d1-omni-600M reads a whole question in one batch, so the server's `-b`/`-ub` must hold the entire request (the launch line below uses 4096; raise up to 16384 for long states). The state passed to the decision model is trimmed to `decision.stateMaxChars` so the request fits that batch.

Serving is llama.cpp with the official GGUF (`LiquidAI/d1-omni-600M-GGUF`) — no Python, no pip:

```bash
llama-server -hf LiquidAI/d1-omni-600M-GGUF:Q8_0 -b 4096 -ub 4096
```

Requires llama.cpp ≥ 0.7.0 (d1-omni support merged as PR #30114; older builds fail with "unsupported decision model type"). Single-model servers ignore the `model` field. The plugin never spawns or kills the server; it health-checks at init and logs actionable guidance when unreachable.

d1-omni is multimodal (images, and up to 30 s of speech). The plugin sends text-only state today; multimodal evidence is future work (§10).

### 3.2 Nodes

| Node | Trigger | Question type | Output | Decision rule |
|---|---|---|---|---|
| **Gate** | debounced user-message batch (only user-authored messages drive the pipeline) | `noul` | P(update intent) | `P ≥ intent.gateThreshold (0.5)` → update; else skip. Always update when no intent exists. |
| **Update** | gate = yes, change event (edit/removal), or user-approved clearance (§3.5) | — (`ctx.generate.text`) | revised intent markdown | free rein over the intent — incremental edit or full overwrite ("here is the current intent and this user-message change; update it as you see fit"); subject to §5.6 max-chars shrink loop |
| **Guard** | `execute.before`, `shell` only | `choice` + `score` (one pass) | P(scope), confidence, expected severity | safe iff `within_scope` **and** `confidence ≥ decision.safeConfidence (0.85)`; else mismatch |

When the gate skips, `intentVersion` does not change — the guard cache stays warm and no further model calls happen.

Revocations are first-class: `message.removed` and edited-message events **skip the gate** and always run the Update, with the change event as input ("user message `msg_42` was edited — the text 'migrate prod' no longer exists; superseded by 'rehearse on staging'"). A revoked instruction must never survive in the intent just because no *new* message arrived.

### 3.3 Storage format

`.opencode/intent/<sanitizedSessionId>.md`:

```
---
intentVersion: 4
lastMessageId: msg_41
updatedAt: 2026-09-05T12:00:00.000Z
charCount: 612
---

<markdown body, <= intent.maxChars>
```

Writes are atomic (temp file + `fs.rename`, with `fsync` of the temp file before the rename) and **compare-and-swap on `intentVersion`**: the writer carries the version it read; if the file has moved on, the stale draft is discarded and the update re-run. Last-write-wins is not enough — a stale draft must never clobber a newer intent.

### 3.4 Guard cache

Guard verdicts are cached in-memory keyed by `sha256("shell" + "\0" + canonicalJSON(args) + "\0" + intentVersion)` (canonical JSON = sorted keys, so key order never splits the cache or changes a verdict) for `validate.cacheTtlMs`. The cache auto-invalidates when the intent version bumps (next `intent.updated`).

### 3.5 Approval absorption

When the guard blocks a command and the user approves it through the agent's `question` tool, the clearance is absorbed into the intent so the same command does not block again:

1. **Block.** `CastlegateIntentMismatchError` (§4.3) tells the agent to ask the user. It carries `Blocked at: <ISO timestamp>` and a fresh `blockId`; the plugin keeps a pending-block record `{ blockId, sessionId, command signature }` in memory.
2. **Ask.** The agent calls its `question` tool with **exactly two options: `Approve` and `Deny`**, the `blockId` in the prompt, and a question about the command. The plugin does not trust the agent to describe the command: a `ctx.tool.hook("execute.before", { name: "question" })` transform injects `Blocked command: \`<exact args>\`` into the prompt verbatim.
3. **Observe.** A `ctx.tool.hook("execute.after", { name: "question" })` hook reads the answer. An answer is **consumed only when the prompt carries a `blockId` with a pending block** — unrelated questions never touch guard state. Matching is **fail-closed**: approval counts only when the answer is exactly `approve` (trimmed, case-insensitive) — the `Approve` option, or the user literally typing "approve". Anything else — including any other free text (the harness may always offer "type your own answer") — is treated as denial: no clearance, no absorption, the command stays blocked. On approval the plugin appends to the question result:
   `CASTLEGATE_CLEARANCE: approvedAt <ISO timestamp> — the intent absorbs this clearance within <approval.absorbWaitSeconds>s.`
   so the answer time is visible to the agent and it can count elapsed time itself.
4. **Replay allow.** The exact command signature (sha256 over canonical JSON with sorted keys) is marked cleared for `approval.replayTtlMs` (default 5 min): a retry of the identical command passes `execute.before` immediately, with no guard call.
5. **Absorb.** The Update node (§3.2) folds the clearance into the intent as a dated entry ("user approved `<command summary>` at `<timestamp>`"), bumping `intentVersion`. From then on the guard sees it as in-scope — the intent itself is the approval journal. Absorption is expected to complete well within `replayTtlMs`; if it outlives it, log `intent.absorb_slow` — a bug signal, not normal operation.
6. **Wait.** The agent is instructed to wait `approval.absorbWaitSeconds` (default **60**) after the answer before expecting *similar* (non-identical) commands to pass, since step 5 is asynchronous.

On "deny" nothing changes: the command stays blocked and no intent update happens.

## 4. Public surface

### 4.1 Plugin entry (V2)

```ts
// src/index.ts
import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "opencode-castlegate",
  async setup(ctx) { /* hooks, subscriptions */ return cleanup; },
});
```

A `server()` V1 shim may coexist on the same default export during the migration window; V2 is the supported surface.

### 4.2 Custom tool

Registered via `ctx.tool.transform` (JSON Schema input, structured content output):

```
intent_context
  args: { format?: "summary" | "raw" }
  returns: { content, metadata: { version, lastMessageId, updatedAt, charCount } }
```

### 4.3 Tagged errors

All errors carry a stable tag and stable message format so the agent can parse them.

```ts
class CastlegateIntentMismatchError extends Error {
  readonly tag = "CASTLEGATE_INTENT_MISMATCH";
  readonly tool: string;
  readonly reason: string;
  readonly severity: "low" | "medium" | "high";
  readonly blockedAt: string; // ISO timestamp
  readonly blockId: string; // binds the approval to this exact block (§3.5)
}
```

```
CASTLEGATE_INTENT_MISMATCH: tool '<name>' did not match the current session intent.
Reason: <synthesized decision evidence>
Severity: <low|medium|high>
Blocked at: <ISO timestamp>
Block id: <blockId>
Action required: surface this to the user via the question tool with exactly two options: Approve / Deny, including the block id verbatim in the question. Tell the user to pick the Approve option or type exactly 'approve' — any other answer counts as refusal. Only an explicit 'approve' unlocks the command; free text never does.
If the user approves: the clearance is absorbed into the intent within <approval.absorbWaitSeconds>s — a CASTLEGATE_CLEARANCE line carrying the approval time is appended to the question result, so you can count elapsed time. Retry the same command immediately; wait <approval.absorbWaitSeconds>s before expecting similar commands to pass without asking.
If the user denies: do not retry the tool call.
```

`reason` is synthesized from decision-model output (the decision model returns no free-text rationale):

```
decision: out_of_scope p=0.91, confidence 0.88, severity 2/2 (destructive)
```

Severity mapping from the guard `score` expected value (0..2): `< 0.5` → low, `< 1.5` → medium, `≥ 1.5` → high.

```
CASTLEGATE_API_UNAVAILABLE: castlegate cannot reach the <gate|guard> decision server at <baseURL> after <N> attempts.
The plugin cannot make safety decisions.
Set "enabled": false or comment out opencode-castlegate in opencode.json until the API is back.
```

```
CASTLEGATE_INTENT_TOO_LONG: intent body exceeded <maxChars> characters after <shrinkAttempts> attempts.
The previous intent was kept unchanged.
Please open an issue at https://github.com/Martins6/opencode-castlegate
```

### 4.4 Config

Options are passed through the V2 `plugins` entry and read from `ctx.options`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-castlegate",
      "options": {
        "enabled": true,
        "decision": {
          // System One decision model server (llama.cpp llama-server with the d1 GGUF)
          "baseURL": "http://127.0.0.1:8080/v1/systemone",
          "model": "LiquidAI/d1-omni-600M-GGUF:Q8_0", // ignored by single-model servers
          "timeoutMs": 10000,
          "stateMaxChars": 8000, // state trim so the request fits the server batch (-b/-ub); a 400 here is a config error, never "api unavailable"
          "gateThreshold": 0.5, // P(update) above this → update the intent
          "safeConfidence": 0.85 // act automatically only at/above this confidence
        },
        "update": {
          // OpenCode's own model via ctx.generate.text — no external API, no API key
          "model": null, // optional provider/model override; null = the session's configured model
          "timeoutMs": 60000
        },
        "approval": {
          "absorbWaitSeconds": 60, // the agent waits this long after approval for the intent update
          "replayTtlMs": 300000 // identical command passes without a guard call for this long
        },
        "intent": {
          "maxChars": 10000, // X in the shrink loop
          "shrinkAttempts": 3,
          "maxRecentMessages": 20
        },
        "validate": {
          "tools": ["shell"], // v2 tool name (v1: "bash")
          "skip": [],
          "requireApprovalOnMismatch": true,
          "onApiUnavailable": "block", // "block" = fail closed (default) | "allow" = fail open while the server is down
          "cacheTtlMs": 30000
        },
        "retries": 2, // per decision-server call, before giving up
        "storage": { "directory": ".opencode/intent" },
        "logging": true
      }
    }
  ]
}
```

No external API keys are required: the decision server is self-hosted and the update node runs on the model OpenCode is already configured with.

## 5. Behavioral contracts

### 5.1 What `shouldValidate` returns

| Condition | Result |
|---|---|
| `tool` ∉ `validate.tools` (default `["shell"]`) | `false` (skip, zero cost) |
| `tool` ∈ `validate.skip` | `false` (skip) |
| command signature is replay-cleared (§3.5) | `false` (skip — user already approved it) |
| otherwise | `true` |

### 5.2 What the decision nodes return

Typed answers only — nothing to parse:

- Gate (`noul`): `number` = calibrated P(update intent).
- Guard (`choice`): `{ choice: "within_scope" | "out_of_scope", probabilities, confidence }`.
- Guard (`score`): expected severity level 0..2 + distribution + confidence.

### 5.3 What happens on guard "not safe" when `requireApprovalOnMismatch: true`

`CastlegateIntentMismatchError` is thrown from the `execute.before` hook. OpenCode converts this to a tool error for the agent. The command never executes. The agent is expected to call its `question` tool with a yes/no choice quoting the command. Low confidence (`< decision.safeConfidence`) counts as not safe — uncertain means escalate to the user.

The approval flow, timestamps, replay behavior, and wait instruction are specified in §3.5: on approval the clearance is absorbed into the intent (Update node), the question result carries `approvedAt`, and the agent waits `approval.absorbWaitSeconds` (default 60) for the intent before expecting similar commands to pass. The question must offer exactly two options — `Approve` and `Deny` — and approval detection is fail-closed (§3.5 step 3): any answer other than exactly `approve` is treated as denial.

### 5.4 What happens when a server is unreachable (`retries`)

Each decision-server call retries `retries` times (default 2) with exponential backoff + jitter and a per-attempt timeout. After exhaustion: `CastlegateApiUnavailableError` (message recommends `enabled: false` or commenting out the plugin). A per-node circuit breaker opens after 3 consecutive failures and fails fast for 60s. When the guard cannot decide, the default is **block** (`validate.onApiUnavailable: "block"`): every gated call fails until the server is back. Set `"allow"` to opt into fail-open. In the event-driven update path — and when `ctx.generate.text` itself fails — the error is logged (`intent.update_error`) and the intent is kept unchanged.

### 5.5 What happens when no intent exists yet

`validate.skip_no_intent` is logged and the tool call is allowed through. The gate always votes "update" when no intent exists, so the first batch populates it.

### 5.6 Enforce max chars (shrink loop)

The update node's output (generated by `ctx.generate.text`) must fit `intent.maxChars` (default **10000**). Enforcement is a loop of up to `intent.shrinkAttempts` (default **3**) generations:

```
for attempt in 1..shrinkAttempts:
    intent = update node response
    if len(intent) <= intent.maxChars:
        save atomically, bump intentVersion, done
    else:
        send the prompt back with:
        "Make it smaller, you've passed the <maxChars> limit."
        (the oversize draft is included as the text to shrink)
```

If the loop breaks without a compliant intent (all `shrinkAttempts` responses exceed the limit):

- the previous intent is kept unchanged (nothing is saved, no version bump),
- `CastlegateIntentTooLongError` is raised to the session (`ctx.session.synthetic`) and logged as `intent.too_long`,
- the error message recommends that the user open an issue at https://github.com/Martins6/opencode-castlegate.

No silent truncation: an intent that cannot fit the limit is a bug report, not something to paper over.

### 5.7 Trust boundaries and adversarial inputs

- **Only user-authored messages change the intent.** The gate/update pipeline is driven by user-role messages alone. Assistant text, tool output, fetched pages, and file content never enter the intent — untrusted text can influence the guard only as *evidence it reads*, never as *policy it writes*. The approval path (§3.5) is the only other writer, and it writes only what the user approved (command summary + `blockId` + timestamp).
- **Approvals are bound to a `blockId`** (§3.5): an answer without a pending `blockId` never clears anything, and the plugin — not the agent — states which exact command is being approved.
- **Subagents inherit the root intent.** A gated call from a child session validates against the root session's intent; a missing intent file in a child session is never a bypass.
- **Signatures and cache keys are canonical** (sorted-key JSON before hashing) — key order can never change a verdict or split a cache.
- **Size discipline.** The intent body is bounded by the shrink loop (§5.6) and never silently truncated. The state sent to the decision server is trimmed to `decision.stateMaxChars`, keeping the anchor intent and clearance entries first. If the request still exceeds the server batch, the 400 is surfaced as a config error and logged — never mapped to `CASTLEGATE_API_UNAVAILABLE`, never counted by the circuit breaker.
- **No unhandled rejections.** Every background path (debounce timers, decision fetches, `ctx.generate.text`, absorption runs) carries its own error handling, and cleanup aborts in-flight work via `AbortSignal`. A stray rejection must never crash the host.

## 6. Lifecycle

| V2 hook | Behavior |
|---|---|
| `setup(ctx)` | parse config; init-time health check of the decision server (log guidance if unreachable) |
| `ctx.event.subscribe()` → `session.created` | initialize empty intent file (`intentVersion: 1`, body `""`) |
| `…` → `message.updated` / `message.part.updated` / `message.part.removed` / `message.removed` | debounce 1s, coalesce in-flight updates; new user message → gate → update; edit/removal → skip gate → update with the change event (§3.2) |
| `…` → `session.deleted` | delete intent file, cancel the session's pending debounce, tombstone the session so any in-flight update discards its write; drop per-session state |
| `ctx.tool.hook("execute.before", { name: "shell" })` | guard (or replay allow, §3.5) |
| `ctx.tool.hook("execute.before", { name: "question" })` | inject `Blocked command: …` + `blockId` into the question prompt (the agent is not trusted to quote it) |
| `ctx.tool.hook("execute.after", { name: "question" })` | consume the answer only if it carries a pending `blockId`; on `approve` append `CASTLEGATE_CLEARANCE` (approvedAt), mark replay-cleared, schedule the absorb update |
| cleanup fn returned by `setup` | cancel timers, clear caches |

## 7. Logging

All events flow through the app log with `service: "castlegate"` (V1 `client.app.log`; V2 logging equivalent to be confirmed during the port). Tool argument values are never logged; only the keys (e.g. `["command"]`) and the decision evidence (probabilities, confidence). Event list: `gate.update`, `gate.skip`, `guard.allow`, `guard.block`, `approval.replay_allow`, `approval.absorbed`, `intent.too_long`, `api.retry`, `api.unavailable`.

## 8. Failure modes

| Mode | Symptom | Mitigation |
|---|---|---|
| Decision server unreachable | `api.unavailable`; `CastlegateApiUnavailableError` after retries | Retries + circuit breaker + "comment out plugin" guidance |
| Update generation fails (`ctx.generate.text`) | `intent.update_error`; intent unchanged | Same policy; guard keeps validating against the old intent |
| Absorption update fails after an approval | clearance not written to the intent; identical command still passes via the replay TTL | replay allow (§3.5) covers `approval.replayTtlMs`; absorption retried on the next gate update; if the TTL expired the agent re-asks the user |
| Shrink loop exhausts | `CASTLEGATE_INTENT_TOO_LONG`; intent unchanged | Error to the session + GitHub issue recommendation (§5.6) |
| Gate false negative (says "no" while intent shifted) | intent drifts stale | Conservative gate prompt ("when in doubt, yes"); always "yes" when no intent; tunable `gateThreshold` |
| Guard low confidence | escalation instead of auto-allow | Intended: uncertain → ask the user (§5.3) |
| State exceeds the server batch (`-b`/`-ub`) | request rejected (400) or decisive context truncated | `decision.stateMaxChars` trim with anchor intent + clearances first (default 8000); 400 is a config error, never `CASTLEGATE_API_UNAVAILABLE`; document raising `-b`/`-ub` up to 16384 |
| Intent file corrupted | `loadIntent` returns `null` → treated as no intent → tool allowed | Atomic writes + version field; future: checksum |
| Two intent updates race | a stale draft would clobber a newer intent | CAS on `intentVersion` (§3.3): the stale draft is discarded, the update re-run |
| Session deleted while an update is pending | orphan intent file re-created after the delete | tombstone + debounce cancel on delete (§6): in-flight saves for a dead session are discarded |

## 9. OpenCode V2 compliance

The current repo implementation is V1. **V1 plugin implementations do not run in V2** — the port is mandatory. Mapping (from the official V2 plugin migration guide):

| Area | V1 (current repo) | V2 (target) |
|---|---|---|
| Package | `@opencode-ai/plugin` | `@opencode/plugin` |
| Entrypoint | `Plugin` async fn returning hooks object | `export default Plugin.define({ id: "opencode-castlegate", setup(ctx) })` |
| Tool gate | `"tool.execute.before"` key | `ctx.tool.hook("execute.before", …)` |
| Tool result hook | `"tool.execute.after"` key | `ctx.tool.hook("execute.after", …)` (used for `question` approval detection, §3.5) |
| Events | `event` hook key | `ctx.event.subscribe({ signal })` async iterable |
| Dispose | returned `dispose()` | cleanup function returned by `setup` |
| Custom tool | `tool()` + zod helper map | `ctx.tool.transform(editor => editor.add({ name, input: JSON Schema, execute }))` |
| Text generation | OpenAI SDK → external API | `ctx.generate.text` (the configured OpenCode model) |
| Session/messages | `client.session.create/prompt/messages` | `ctx.session.create/context`; `ctx.session.synthetic` for raising errors to the session |
| Options | fn arg + top-level `opencode-castlegate` key | `ctx.options` from `plugins[].options` |
| Plugin storage | custom files | `ctx.storage` |
| Gated tool name | `bash` | **`shell`** |
| Permission action | `bash` | **`shell`** (also `task` → `subagent`, `write`/`patch` → `edit`) |
| Local plugin dir | `.opencode/plugin/` | `.opencode/plugins/` |

Alternative V2 surface under consideration: `ctx.permission.hook("evaluate", …)` can express the guard verdict natively (`event.effect = "allow" | "ask" | "deny"`, `event.message` = reason, shown in the permission prompt). The tagged-error contract (§4.3) is the primary surface; the permission hook is a candidate replacement for the question-tool flow.

### 9.1 Name purge — the old name must not survive the port

The one standard term is **intent**: the aggregated intent of the user, accumulated per session, that guard calls validate against. Canonical names after the port:

- `intentVersion` — frontmatter field, bumps on every save
- `loadIntent` / `saveIntent` — storage functions
- `CastlegateIntentTooLongError` / `CASTLEGATE_INTENT_TOO_LONG` — the shrink-loop error
- `validate.skip_no_intent`, `intent.too_long`, `intent.update_error` — log events
- prose, logs, README: "intent", "intent file", "intent body" — no synonym

Purge command for the codebase — every hit must be renamed until this returns nothing:

```bash
rg -n -i 'digest' src test docs scripts README.md package.json
```

## 10. Future work

- Persist clearances across restarts (the replay journal is in-memory and session-scoped; absorbed intent entries already survive).
- Heuristic-only mode (`validate.mode: "heuristic"`) for zero-cost gating when no model server is available.
- Multimodal guard state: feed screenshots or a short voice clip to d1-omni (it accepts images and up to 30 s of speech) for richer safe/not-safe evidence.
- Compaction hook integration (`ctx.session.hook("compaction", …)`) so the intent survives long sessions without losing the anchor intent.
- `ctx.permission.hook("evaluate")` integration in place of / alongside the tagged error (§9).

## 11. Compatibility

- OpenCode ≥ 2.0 (V2 plugin API: `@opencode/plugin`, `ctx.tool.hook`, `ctx.event.subscribe`, `ctx.generate.text`, `ctx.session.synthetic`)
- zod 4.1.x (locked; config validation only — tool schemas are JSON Schema in V2)
- Node ≥ 20 for development (type-check, tests). Runtime is bun, shipped via opencode.
- Decision server: any server conforming to the llama.cpp `/v1/systemone` contract (PR #29818, llama.cpp ≥ 0.7.0). Default model `LiquidAI/d1-omni-600M-GGUF:Q8_0` (LFM Open License v1.0; d1-omni support is PR #30114). No other external services; no API keys.
