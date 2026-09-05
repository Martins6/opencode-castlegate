# castlegate security model

## Threat model

castlegate is a **defense-in-depth** layer on top of OpenCode's permission system. It is designed to catch the common case where an agent does something surprising — not to replace OS-level sandboxing, network policy, or secret management.

In scope:

- An agent drifting away from the user's stated session intent and making tool calls the user would not have approved.
- Repeated trivial mistakes that the user has already corrected once in the conversation.
- "Drive-by" tool calls (e.g. installing packages, running unrelated tests) that creep into a focused refactor.

Out of scope:

- A *deliberately* compromised model that intends to exfiltrate data — it can craft intent-matching phrasings or call tools castlegate is told to skip.
- Prompt injection from tool *outputs* (e.g. a poisoned webfetch page that instructs the model). castlegate validates tool *call args*, not what the model does with results.
- Resource exhaustion from the lightweight model itself; rate-limit upstream if this matters.

## Fail-open vs fail-closed

`validate.failOpenOnError` controls what happens when the validator itself fails (network blip, model error, malformed response):

| `failOpenOnError` | Behavior on validator error |
|---|---|
| `true` (default) | Log a warning, allow the tool call to proceed |
| `false` | Throw `CastlegateIntentMismatchError` as if it were a mismatch |

**Default is fail-open** so transient outages don't break sessions. Flip to `false` for high-risk projects where you would rather the agent stop and check in than proceed with a stale (or missing) intent digest.

## What gets logged

`logging: true` emits structured events through `client.app.log` with `service: "castlegate"`:

| Event | When | Notable fields |
|---|---|---|
| `session.initialized` | `session.created` | `sessionID` |
| `intent.updated` | digest update succeeds | `version`, `compacted`, `intentShift`, `chars` |
| `intent.update_error` | digest update throws | `error` |
| `validate.match` | tool call matches digest | `tool`, `cached`, `severity` |
| `validate.mismatch` | tool call does not match | `tool`, `reason`, `severity`, `argKeys` |
| `validate.error` | validator itself failed | `tool`, `error` |
| `validate.skip_no_digest` | no digest yet for session | `tool` |
| `validate.digest_load_error` | could not load digest from disk | `tool`, `error` |

Tool arguments are **never** logged in full — only the keys (e.g. `["command"]`, `["filePath"]`) and the validator's `reason`.

## Permission flow

When a mismatch is detected and `validate.requireApprovalOnMismatch` is `true`:

1. castlegate throws `CastlegateIntentMismatchError` from `tool.execute.before`.
2. OpenCode surfaces the error to the agent as a tool error.
3. The agent is expected to use the `question` tool to ask the user for explicit approval before retrying the call.
4. The tool call does **not** execute until the user approves.

This works because of OpenCode's separation between agent error handling and tool execution: a thrown error in `tool.execute.before` aborts the tool call before it reaches the runtime.

When upstream opencode lands a native `permission.ask` API inside `tool.execute.before` (issues #37164, #34327), castlegate will switch to using it without changing this contract.

## Cache and replay

`validate.cacheTtlMs` (default 30s) caches validation results keyed by `hash(tool, args, digestVersion)`. This means:

- A repeated call within the window reuses the prior decision. This is intentional: if the agent retries an identical call after you approved it once, castlegate doesn't redo the LLM round-trip.
- The cache is invalidated whenever the digest version bumps (after `intent.updated`). New context → new decisions.

## Files written

- `.opencode/intent/<sessionId>.md` — the digest for each session. Format is plain markdown with a YAML-ish front-matter header. **Not gitignored by default;** add it to `.gitignore` if you don't want digest snapshots in source control.
- No other files are written.

## Outbound network

Every validated tool call adds one outbound call to the configured lightweight model. On long sessions with many tool calls, this can dominate cost. Mitigations:

- `validate.skip` for tools you don't care about (e.g. `read`, `glob`, `grep`).
- `validate.cacheTtlMs` (already on by default).
- `validate.tools` to whitelist only the high-risk tools.
