# opencode-castlegate

OpenCode plugin that **auto-approves tool calls when they match your session intent**, and surfaces mismatches to you before execution.

See [`SPEC.md`](./SPEC.md) for the full architecture and behavioral contract. Security model: [`docs/security-model.md`](./docs/security-model.md). Config schema: [`docs/config.md`](./docs/config.md).

---

## How it works

The moving parts, named exactly as [`SPEC.md`](./SPEC.md) §3.2 names them (one name per thing):

- **Gate node** — decides *whether* new user messages change the session intent.
- **Update node** — rewrites the intent document (incremental edit or full rewrite) when the gate says yes, or folds in an approved clearance.
- **Guard node** — decides *safe / not safe* for each proposed `shell` call against the intent; safe calls run, mismatches are surfaced to you before execution.
- **Approval absorption flow** (SPEC §3.5) — when you approve a blocked command through the agent's `question` tool, the approval is folded into the intent as a dated clearance entry, so the same command does not block again.

---

## Install

```sh
opencode plugin add opencode-castlegate@latest
```

That is it. The plugin works **zero-config**: when no `model` block is set in `opencode.json`, it uses opencode's session-default model for the lightweight intent validator. If you want to pin a specific fast/cheap model, add a single block:

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-castlegate@latest"],
  "opencode-castlegate": {
    "model": { "providerID": "anthropic", "modelID": "claude-haiku-4-5" }
  }
}
```

See [`docs/config.md`](./docs/config.md) for the full schema.

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

OpenCode runs `bun install` on startup to resolve `.opencode/package.json`, then loads the package named in the `plugin` array. No `.opencode/plugins/` file is needed for this package. If you previously copied `opencode-castlegate.ts` into that directory, remove it so the plugin is not registered twice.

### 4. Configure

Add the `opencode-castlegate` block to your host project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-castlegate"],
  "opencode-castlegate": {
    "model": { "providerID": "anthropic", "modelID": "claude-haiku-4-5" },
    "intent": { "maxChars": 4000, "compactThreshold": 0.8, "maxRecentMessages": 20 },
    "validate": {
      "tools": ["bash", "edit", "write", "webfetch"],
      "skip": ["read", "glob", "grep"],
      "requireApprovalOnMismatch": true,
      "failOpenOnError": true,
      "cacheTtlMs": 30000,
      "mode": "llm"
    },
    "storage": { "directory": ".opencode/intent" },
    "logging": true
  }
}
```

> **Note on `min-release-age`.** If your npm configuration sets a release
> age (for example, `min-release-age=7`), recent `@opencode-ai/plugin`
> releases are intentionally hidden until they are old enough. Opencode's
> installer may report that the version matching the CLI cannot be found.
>
> If you hit that error, pin a compatible version older than your configured
> release-age window in your host project's `.opencode/package.json`. For
> example, `1.18.32` predates the seven-day window observed in October 2026:
>
> ```json
> {
>   "dependencies": {
>     "@opencode-ai/plugin": "1.18.32",
>     "opencode-castlegate": "file:/absolute/path/to/opencode-castlegate"
>   }
> }
> ```
>
> Remove this override once the CLI-matched version is available under your
> package-manager policy.

See [`docs/config.md`](./docs/config.md) for the full schema.

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
{"ts":"2026-11-02T12:34:56.789Z","pid":4242,"service":"castlegate","level":"info","event":"guard.block","sessionID":"ses_abc","blockId":"cb_x","decision":"deny"}
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

## Project layout

```
opencode-castlegate/
├── SPEC.md                   Architecture + behavioral contract
├── README.md                 This file (dev install)
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              Plugin entry — wires all hooks
│   ├── config.ts             Zod schema + parser
│   ├── errors.ts             CastlegateIntentMismatchError
│   ├── store.ts              Atomic digest store on disk
│   ├── intent.ts             updateDigest (lightweight LLM merge)
│   ├── validate.ts           validateToolCall + LRU cache
│   ├── log.ts                Structured event logger
│   ├── prompts/
│   │   ├── intent-update.ts  Digest-merge prompt + parser
│   │   └── intent-validate.ts Validator prompt + parser + arg summarizer
│   └── tools/
│       └── intent-context.ts Custom intent_context tool
├── test/                     Node --test suite (34 tests)
├── scripts/
│   └── manual-e2e.ts         Boot fake client, exercise hooks
└── docs/
    ├── config.md             Full config reference
    └── security-model.md     Threat model + logging + caching
```

## License

MIT
