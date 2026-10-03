# opencode-castlegate configuration

The `opencode-castlegate` block in `opencode.json` (or `.opencode/opencode.json`) accepts the following keys. Defaults are shown.

```ts
{
  model?: {
    providerID: string,         // optional — defaults to opencode's session-default model
    modelID: string,            // optional — defaults to opencode's session-default model
  },
  intent: {
    maxChars: number,           // default 4000 — hard cap on digest size
    compactThreshold: number,   // default 0.8 — fraction of maxChars at which a compact run is requested
    maxRecentMessages: number,  // default 20 — how many recent messages to feed the lightweight model per digest update
  },
  validate: {
    tools?: string[],           // optional allowlist; when set, ONLY these tools are validated
    skip: string[],             // default [] — these tools are NEVER validated
    requireApprovalOnMismatch: boolean, // default true — throw tagged error on mismatch
    failOpenOnError: boolean,   // default true — allow tool call when validator errors
    cacheTtlMs: number,         // default 30000 — skip repeat-validating identical calls within this window
    mode: "llm" | "heuristic" | "both", // default "llm" — validator mode (heuristic-only is a future enhancement)
  },
  storage: {
    directory: string,          // default ".opencode/intent" — relative paths resolve against the project directory
  },
  logging: boolean,             // default true — emit structured events via client.app.log
}
```

> **Zero-config default.** When `model` is omitted, the plugin omits the `model` field from `client.session.prompt` and lets opencode resolve the session-default model. This is the recommended starting point — most users will never need to set `model`. Override only if you want to pin a specific fast/cheap model for the lightweight validator.

## Behavior notes

- **`validate.tools`** is the strongest signal: set it to gate only the tools you consider high-risk. If unset, every tool is validated (subject to `skip`).
- **`validate.skip`** is honored even when `validate.tools` is set.
- **`intent.maxChars`** is enforced after each digest update: any output over the limit is truncated. Compaction is requested (via the lightweight model) when the digest is at or above `intent.compactThreshold * intent.maxChars`.
- **`validate.cacheTtlMs`** is a *defensive* cache, keyed by `hash(tool, args, digestVersion)`. Set to `0` to disable.
- **`storage.directory`** is resolved against the plugin's working directory at runtime, so you can point it outside the project if desired.

## Minimal config

Zero-config (no `opencode-castlegate` block at all) works out of the box — the plugin uses opencode's session-default model.

To pin a specific fast/cheap validator model:

```json
{
  "opencode-castlegate": {
    "model": { "providerID": "anthropic", "modelID": "claude-haiku-4-5" }
  }
}
```
