# castlegate

OpenCode plugin that **auto-approves tool calls when they match your session intent**, and surfaces mismatches to you before execution.

See [`SPEC.md`](./SPEC.md) for the full architecture and behavioral contract. Security model: [`docs/security-model.md`](./docs/security-model.md). Config schema: [`docs/config.md`](./docs/config.md).

---

## Dev install (local)

This repo is for development against a host opencode installation. The plugin is loaded as a single TypeScript file copied into your project's `.opencode/plugins/` directory.

### 1. Clone and install dependencies

```bash
git clone https://github.com/Martins6/castlegate.git
cd castlegate
npm install
```

### 2. Verify the build is healthy

```bash
npm run typecheck
npm test
```

Tests use Node's built-in test runner via `--experimental-strip-types`. bun is **not** required for development; opencode itself runs the plugin under bun at runtime.

### 3. Link it into a host project

Pick a project where you want to use castlegate, then:

```bash
# from inside the host project
mkdir -p .opencode/plugins
mkdir -p .opencode
```

Create `.opencode/package.json` with a `file:` dependency:

```json
{
  "dependencies": {
    "castlegate": "file:/absolute/path/to/castlegate"
  }
}
```

Copy the plugin entry into the host's plugin directory:

```bash
cp /absolute/path/to/castlegate/src/index.ts /path/to/host/.opencode/plugins/castlegate.ts
```

OpenCode runs `bun install` on startup to resolve `.opencode/package.json`, then loads every `*.ts` file in `.opencode/plugins/`.

### 4. Configure

Add the `castlegate` block to your host project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["castlegate"],
  "castlegate": {
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

After editing files in this repo, re-run the host project's opencode (it auto-reloads plugins on session start). To iterate without restarting opencode:

1. Edit files here.
2. Re-run `cp src/index.ts /path/to/host/.opencode/plugins/castlegate.ts`.
3. Restart the opencode session in the host project.

## Project layout

```
castlegate/
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
