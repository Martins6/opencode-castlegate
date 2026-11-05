# opencode-castlegate

OpenCode plugin that **auto-approves tool calls when they match your session intent**, and surfaces mismatches to you before execution.

See [`SPEC.md`](./SPEC.md) for the full architecture and behavioral contract (config schema: [§4.4](./SPEC.md#44-config), trust boundaries: [§5.7](./SPEC.md#57-trust-boundaries-and-adversarial-inputs), failure modes: [§8](./SPEC.md#8-failure-modes)).

---

## How it works

A rolling **intent** is maintained per session, written **only from your messages** — assistant text, tool output, and file content never enter it. Three nodes drive it:

- **Gate** (decision model) — do new user messages change the intent? If yes, the **Update** node rewrites it using the model OpenCode is already configured with.
- **Guard** (decision model) — is this proposed `shell` command within the intent? **Safe** → it runs with no prompt. **Not safe** → it is blocked and the agent asks you; on approval the clearance is absorbed into the intent, so the same command (and close variants) stops asking.

All binary decisions come from a **self-hosted decision model** ([d1-omni-600M](https://huggingface.co/LiquidAI/d1-omni-600M-GGUF) served by llama.cpp over the System One `/v1/systemone` contract). No external LLM API and no API keys — the only external component is that decision server.

What castlegate is **not**: not a sandbox (no OS-level isolation), not a static permission system (use OpenCode's `permissions` for pattern rules), and not a replacement for your judgment — you can always say "yes".

Want to see it live? [`live-test/`](./live-test/README.md) is a ready-to-use sandbox with scripted TUI scenarios (intent maintenance, guard block → approval → absorption, headless runs).

---

## Prerequisites

- [OpenCode](https://opencode.ai) ≥ 2.0 (V2 plugin API)
- **A decision model server** (required — there is no default). Any server conforming to the llama.cpp `/v1/systemone` contract works. Two ways to get one:

  **Option A — [llama.app](https://llama.app/) (easiest).** The menu-bar app by the llama.cpp team and Hugging Face; it manages the engine, the settings, and the models. Install it:

  ```bash
  curl -LsSf https://llama.app/install.sh | sh
  ```

  Then open Llama from the menu bar, pick **Browse models**, and install the decision model **`LiquidAI/d1-omni-600M-GGUF`** (the `Q8_0` build). llama.app serves every installed model from one OpenAI-compatible endpoint (`localhost:9931/v1` by default — the port is shown in the app) and routes by model name. Verify the decision model is listed:

  ```bash
  curl -s http://127.0.0.1:9931/v1/models   # must list LiquidAI/d1-omni-600M-GGUF:Q8_0
  ```

  **Option B — standalone [llama-server](https://github.com/ggml-org/llama.cpp)** (CI, headless boxes). Requires llama.cpp ≥ 0.7.0 with the official d1 GGUF:

  ```bash
  llama-server -hf LiquidAI/d1-omni-600M-GGUF:Q8_0 -b 4096 -ub 4096
  ```

  With a multi-model server (like llama.app) `decision.model` selects the decision model; single-model servers ignore it. A chat model answering `/v1/systemone` returns `501: This model is not a decision model`; castlegate treats that as `CASTLEGATE_API_UNAVAILABLE` (fail-closed, no bypass).

- Node ≥ 20 — development only (type-check, tests); runtime is bun via opencode.

---

## Install

Add the plugin to `opencode.json` (project or global) with its `options` block:

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-castlegate@latest",
      "options": {
        "decision": {
          // REQUIRED — no default. Any /v1/systemone-capable server.
          "baseURL": "http://127.0.0.1:9931/v1/systemone", // llama.app's endpoint (:9931 by default); llama-server users: :8080
          "model": "LiquidAI/d1-omni-600M-GGUF:Q8_0", // required by multi-model servers; ignored by single-model ones
        },
      },
    },
  ],
}
```

Alternatively, `opencode plugin add opencode-castlegate@latest` installs the package globally — then add the `options` block to the entry it creates in `~/.config/opencode/opencode.json`.

Everything else is zero-config: the intent **update** node runs on the session's own model (`update.model: null`), and all thresholds and limits have sensible defaults. The full schema lives in [`SPEC.md` §4.4](./SPEC.md#44-config).

### Verify it is active

1. The `intent_context` tool is registered (the agent can report the current intent on request).
2. `.opencode/intent/castlegate.log` exists (inside `storage.directory`, default `.opencode/intent/`) and contains a `plugin.setup` line.
3. State a goal ("my goal for this session is …"); within a few seconds `.opencode/intent/<session>.md` appears.

Without `decision.baseURL` the plugin logs `api.not_configured` at startup and every gated call fails closed with `CASTLEGATE_DECISION_SERVER_NOT_FOUND` (see [Troubleshooting](#troubleshooting)).

---

## Local development

This repo is for development against a host OpenCode installation. The plugin is loaded as a package from the host project's `.opencode/package.json`. Do not copy individual source files into `.opencode/plugins/`: the entry point imports the rest of the source tree.

### 1. Clone and install dependencies

```bash
git clone https://github.com/Martins6/opencode-castlegate.git
cd opencode-castlegate
npm install
```

### 2. Verify the build is healthy

```bash
npm run typecheck
npm test
```

Tests use Node's built-in test runner via `--experimental-strip-types`. bun is **not** required for development; opencode itself runs the plugin under bun at runtime.

### 3. Link it into a host project

Pick a project where you want to use opencode-castlegate, then:

```bash
# from inside the host project
mkdir -p .opencode
```

Create `.opencode/package.json` with a `file:` dependency:

```json
{
  "dependencies": {
    "opencode-castlegate": "file:/absolute/path/to/opencode-castlegate"
  }
}
```

OpenCode runs `bun install` on startup to resolve `.opencode/package.json`, then loads the package named in the `plugins` array. No `.opencode/plugins/` file is needed for this package. If you previously copied `opencode-castlegate.ts` into that directory, remove it so the plugin is not registered twice.

### 4. Configure

Add the plugin to your host project's `opencode.json`, pointing `decision` at your decision server:

```jsonc
{
  "$schema": "https://opencode.ai/config.json", // editor validation + autocomplete
  "plugins": [
    {
      "package": "opencode-castlegate", // the package linked in step 3 (or "opencode-castlegate@latest" from npm)
      "options": {
        "enabled": true, // master switch — false turns the whole plugin off (no gating, no intent)
        "decision": {
          // Decision model server — REQUIRED, no default; gated calls fail closed without it.
          "baseURL": "http://127.0.0.1:9931/v1/systemone", // the /v1/systemone endpoint (llama.app :9931 by default; llama-server :8080)
          "model": "LiquidAI/d1-omni-600M-GGUF:Q8_0", // which decision model to ask; required by multi-model servers (llama.app), ignored by single-model ones
          "timeoutMs": 10000, // per-request timeout before a decision call counts as unavailable
          "stateMaxChars": 8000, // trims the state sent to the decision model so the request fits the server batch (-b/-ub)
          "gateThreshold": 0.5, // gate node: P("this changes the intent") at/above this value → rewrite the intent
          "safeConfidence": 0.85, // guard node: act with no prompt only at/above this confidence
        },
        "update": {
          "model": null, // model that rewrites the intent — null = the session's own model, or "providerID/modelID" to pin one
          "timeoutMs": 60000, // how long one intent rewrite may take before it is abandoned
        },
        "approval": {
          "mode": "auto", // "auto" = Approve/Deny question flow, degrades to steering in headless runs | "headless" = steering error from block #1
          "absorbWaitSeconds": 60, // after an approval, how long the agent waits for the clearance to land in the intent before retrying
          "replayTtlMs": 300000, // an approved command passes with no guard call at all for this long
        },
        "intent": {
          "maxChars": 10000, // hard cap on the intent body; longer bodies trigger the shrink loop
          "shrinkAttempts": 3, // shrink loop: total rewrite attempts before giving up (then CASTLEGATE_INTENT_TOO_LONG)
          "maxRecentMessages": 20, // how many of the newest user messages the update model sees when folding in a change
        },
        "validate": {
          "tools": ["shell"], // which tools are gated (v2 tool name; v1: "bash")
          "skip": [], // tools never gated, even if listed in "tools"
          "onApiUnavailable": "block", // decision server down: "block" = fail closed (CASTLEGATE_API_UNAVAILABLE) | "allow" = let calls through
          "onMissingIntent": "block", // gated call before the first intent lands: "block" = CASTLEGATE_NO_INTENT | "allow" = pass through
          "noIntentRetrySeconds": 60, // what CASTLEGATE_NO_INTENT tells the agent to wait before retrying
          "noIntentMaxAttempts": 3, // retries allowed before escalating to CASTLEGATE_NO_INTENT_EXHAUSTED
          "cacheTtlMs": 30000, // guard verdicts cached per tool + args + intent version for this long (0 = no cache)
        },
        "retries": 2, // extra attempts per decision-server call (exponential backoff) before giving up
        "storage": { "directory": ".opencode/intent" }, // where intent files and castlegate.log are written
        "logging": true, // structured event log on; false writes only level:"error" lines
      },
    },
  ],
}
```

See [`SPEC.md` §4.4](./SPEC.md#44-config) for what every option does.

### 5. Manual smoke test

Run the bundled end-to-end script (no opencode server required):

```bash
node --experimental-strip-types scripts/manual-e2e.ts
```

You should see output like:

```
plugin loaded: [ 'dispose', 'event', 'tool.execute.before', 'tool' ]
digest file created: true
logs after validation: 0
intent_context tool result: ...
```

### 6. Iterating

After editing files in this repo, restart the host project's OpenCode session. It reruns the `.opencode` dependency install and reloads the package on startup.

If the host project is still using a stale local dependency, run `bun install` from its `.opencode/` directory before restarting the session.

## Debugging

Every structured event (`plugin.setup`, `gate.update`, `gate.skip`,
`guard.allow`, `guard.block`, `intent.updated`, `api.unavailable`, …) is
emitted as one JSON line per event to two sinks:

- **stderr** — captured by the host log in every mode, and
- **`.opencode/intent/castlegate.log`** (inside `storage.directory`) —
  append-only, so the event stream survives even when stderr never reaches
  `opencode.log`. With it, "gate skipped vs update failed vs guard
  false-negative" can be told apart after the fact.

Every line carries `ts` (ISO timestamp) and `pid`, so events from concurrent
processes can be told apart and ordered after the fact. `plugin.setup` logs
the resolved config and `plugin.dispose` closes the stream. Tool argument
values are never logged — only their keys:

```json
{
  "ts": "2026-11-02T12:34:56.789Z",
  "pid": 4242,
  "service": "castlegate",
  "level": "info",
  "event": "guard.block",
  "sessionID": "ses_abc",
  "blockId": "cb_x",
  "decision": "deny"
}
```

Useful recipes:

```bash
# follow the live event stream
tail -f .opencode/intent/castlegate.log

# everything that happened in one session
grep '"sessionID":"ses_abc"' .opencode/intent/castlegate.log

# why was this call blocked?
grep '"event":"guard.block"' .opencode/intent/castlegate.log | jq

# errors only (incl. config.invalid when the plugin disables itself)
grep '"level":"error"' .opencode/intent/castlegate.log
```

The file mirrors the `logging` flag (`logging: false` writes only
`level: "error"` lines). A broken file sink never breaks the plugin: one
`log.file_unavailable` warning on stderr, then it degrades to stderr-only.

## Troubleshooting

Every castlegate error carries a stable tag so you (or the agent) can pattern-match it. Full message templates: [`SPEC.md` §4.3](./SPEC.md#43-tagged-errors).

| Symptom                                                                | Cause                                                                                               | Fix                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CASTLEGATE_DECISION_SERVER_NOT_FOUND` on every gated call             | `decision.baseURL` not set (or the plugin is installed without its `options` block)                 | Add `decision.baseURL` + `decision.model` to the plugin's `options`                                                                                                                                  |
| `CASTLEGATE_API_UNAVAILABLE` / `api.unavailable` in the log            | Decision server unreachable, or a chat model answering `/v1/systemone` (501)                        | Start llama.app (Option A) or the llama-server line (Option B) from [Prerequisites](#prerequisites); or set `"validate": { "onApiUnavailable": "allow" }` to fail open while it is down, or `"enabled": false` to switch the plugin off |
| `CASTLEGATE_NO_INTENT`                                                 | A gated call arrived before the first intent landed (it takes seconds after the first user message) | Wait `validate.noIntentRetrySeconds` and retry once; `CASTLEGATE_NO_INTENT_EXHAUSTED` means something is broken — check `castlegate.log`                                                             |
| `CASTLEGATE_INTENT_MISMATCH`                                           | The guard doing its job                                                                             | Approve or deny via the question tool; approvals are absorbed into the intent                                                                                                                        |
| `CASTLEGATE_HEADLESS_BLOCK`                                            | A block that cannot be approved in a headless run                                                   | Use a different command that fits the stated intent, or run it from an interactive session; `approval.mode: "headless"` makes steering errors the rule from block #1                                 |
| `config.invalid` logged, plugin inert                                  | The `options` block failed schema validation                                                        | Fix the reported fields; the plugin disables itself instead of guessing                                                                                                                              |
| opencode's installer cannot find a matching `@opencode/plugin` version | npm `min-release-age` hides recent releases                                                         | Pin a compatible version in `.opencode/package.json` (dev) or your lockfile (e.g. `"@opencode/plugin": "1.18.32"`), and remove the pin once the version is old enough for your policy                |

## License

MIT
