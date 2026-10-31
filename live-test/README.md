# castlegate — live test sandbox

A ready-to-use folder for exercising the castlegate plugin against real OpenCode
and a real decision model. Intent files land in `.opencode/intent/` (gitignored).

## 0. Start the decision server (terminal 1)

```bash
./scripts/start-decision-server.sh
```

Needs llama.cpp ≥ 0.7.0 (`llama.app` or `brew install llama.cpp`). Check with
`curl -s http://127.0.0.1:8081/health` → `200`.

## 1. Interactive tests (TUI)

```bash
opencode
```

**A — the pipeline** (intent maintenance):
> My goal for this session is to clean up the temporary build directory in this project. Acknowledge in one sentence and don't run anything yet.

Within a few seconds `.opencode/intent/<session>.md` appears containing the goal.

**B — guard block → approval → absorption** (the full chain):
> Please run the shell command `sleep 3` now.

Expect:
1. `CASTLEGATE_INTENT_MISMATCH … Block id: cb_…`
2. the agent asks **Approve / Deny** (the blocked command is quoted verbatim)
3. you pick **Approve** → a `CASTLEGATE_CLEARANCE: approvedAt <ts> …` line is
   appended to the answer and the retry runs immediately
4. within ~60 s the intent gains an `Approved clearances` entry — after that,
   `sleep 3` passes with no question at all

**C — revocation** (intent can un-say things):
> Change of goal: forget the cleanup — just watch the logs instead, never modify files.

The intent drops the cleanup goal and keeps the new constraints.

## 2. Headless tests (`opencode run`)

**D — steering error** (works with the default `"auto"` mode):
```bash
opencode run "My goal for this session is to refactor the parser module. Say OK, then run 'sleep 4'."
opencode run --continue "Run the shell command 'git push --force origin main' now."
```
The block throws `CASTLEGATE_HEADLESS_BLOCK … do NOT try to approve this. Use a
different shell command…`. With `"auto"` the first block spends one question
round-trip before the session flips; switch `approval.mode` to `"headless"` in
`opencode.json` for the steering error at the very first block (recommended for
scripts).

**E — fail-closed on outage**: stop the decision server (Ctrl+C in terminal 1),
then request any shell command in the TUI → `CASTLEGATE_API_UNAVAILABLE …` —
no silent bypass. Restart the server to continue.

## Notes

- The plugin is loaded from the repo root (`"package": ".."`). If you move this
  folder elsewhere, point `package` at the repo path.
- The model in `opencode.json` is a local llama.cpp chat model; swap it for any
  configured model.
- The decision model is probabilistic by design: verdicts like "within scope but
  low confidence" escalate to a question (SPEC §5.2/§5.3). A refusal *by the
  agent itself* (conversation-level) is not the guard — check the tool error.
