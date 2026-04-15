# 1. Objective

Implement Track G as a live native-CLI ACP E2E that proves a cron-triggered prompt reaches the real gateway, creates a real ACP session, produces a completed assistant turn, and leaves verifiable OpenClaw artifacts behind.

The test must stay black-box:

- real `openclaw gateway run`
- real `openclaw cron add/run`
- real `openclaw sessions`
- real ACPX runtime
- real session JSONL on disk
- real gateway log

# 2. Scope and Non-Goals

In scope:

- `scripts/e2e/acp-cli/tests/cron-roundtrip.e2e.ts`
- reuse of Track 0 harness pieces for gateway boot, fixture seeding, transcript parsing, and rule helpers
- minimal `CLAUDE.md` prompt/context patches needed for this track to pass reliably
- unit coverage in `src/agents/acp-workspace-context.test.ts` for any new generated guidance

Non-goals:

- no mocks, fake gateways, or in-process MCP harnesses
- no addition to default `pnpm test`
- no CI workflow work beyond naming the intended nightly/pre-release entrypoints
- no broad ACP prompt cleanup unrelated to cron/heartbeat/reply reliability

Important implementation note:

- In the current repo CLI, `openclaw cron add` requires `--name <name>` and `openclaw cron run` takes a job id. The user-facing flow in this plan should therefore be executed as:
  - `openclaw cron add --name daily-summary --agent claude --every 1m --message "Summarize today's notes briefly." --json`
  - parse returned job `id`
  - `openclaw cron run <jobId> --json`

Important semantics note:

- In the current CLI, `--message` jobs default to `sessionTarget="isolated"` and `payload.kind="agentTurn"`.
- That means the exact flow above proves the cron-triggered agent-turn round-trip.
- If product requires an explicit main-session heartbeat hop, that is a follow-on variant and should use `--session main --system-event ...` or an additional `openclaw system event --mode now`.

# 3. Proposed Flow

1. Reuse Track 0 `harness.sh` to create a fresh `OPENCLAW_HOME`, seed fixtures, pick a free port, boot:
   - `openclaw gateway run --port <p> --bind loopback --allow-unconfigured`
2. Inside `cron-roundtrip.e2e.ts`, capture:
   - `startedAt = Date.now()`
   - baseline sessions from `openclaw sessions --agent claude --json`
3. Add the cron job through the native CLI wrapper:
   - `openclaw cron add --name daily-summary --agent claude --every 1m --message "Summarize today's notes briefly." --json`
4. Parse the cron-add JSON and record:
   - `jobId`
   - `name`
   - `sessionTarget` if present
   - `payload.kind`
5. Trigger the job immediately:
   - `openclaw cron run <jobId> --json`
6. Poll `openclaw sessions --agent claude --json` until a new session appears with `updatedAt >= startedAt`.
   - Prefer the newest session not present in the baseline snapshot.
   - Timeout should be owned by Track 0 helpers, defaulting to about 30s.
7. Read the transcript from:
   - `$OPENCLAW_HOME/agents/claude/sessions/<sessionId>.jsonl`
8. Read the gateway log from:
   - `$OPENCLAW_HOME/gateway.log`
9. Assert transcript behavior and log cleanliness.
10. Clean up the created cron job at the end of the test if the harness keeps the scratch home on failure.

# 4. Harness and Fixture Design

Track G depends on Track 0. Do not build a second harness.

Required Track 0 reuse:

- `scripts/e2e/acp-cli/harness.sh`
  - scratch `OPENCLAW_HOME`
  - gateway lifecycle
  - failure artifact dumping
- `scripts/e2e/acp-cli/driver.ts`
  - add `addCron()`, `runCron()`, `listSessions()`
- `scripts/e2e/acp-cli/transcript.ts`
  - parse per-turn assistant text, tool calls, files read, files written
- `scripts/e2e/acp-cli/rules.ts`
  - existing matcher style for transcript assertions

Track G-specific helper additions:

- `waitForNewSession({ agent, sinceMs, previousKeys })`
  - polls `openclaw sessions --agent <id> --json`
  - returns the newest session row not in the baseline set
- `readGatewayLog()`
  - reads `$OPENCLAW_HOME/gateway.log`
- `mustHaveCompletedAssistantTurn()`
  - asserts the final transcript turn contains assistant output and is not tool-only

Fixture/bootstrap requirements:

- Reuse Track 0 seeded files:
  - `AGENTS.md`
  - `SOUL.md`
  - `IDENTITY.md`
  - `HEARTBEAT.md`
  - minimal `MEMORY.md`
- Reuse Track 0 ACP-enabled `openclaw.json`
- Ensure Track 0 fixture config provides a safe delivery path for default cron announce behavior.
  - This is mandatory because isolated `--message` cron jobs default to announce delivery.
  - Do this in shared fixture/config seeding, not in Track G ad hoc logic.
  - Acceptable solutions:
    - seed a loopback/test delivery channel in config, or
    - seed a previous session entry with resolvable `lastChannel`/`lastTo`

Track G should not:

- bypass delivery by editing runtime internals
- read internal task objects directly
- parse gateway state from anything other than CLI JSON, transcript files, and gateway log

# 5. Assertions

Primary assertions:

- `cron run` exits successfully and returns JSON indicating the run executed or was enqueued successfully.
- `openclaw sessions --agent claude --json` shows a new session after the cron run.
- The corresponding transcript file exists on disk.
- The transcript contains a completed assistant turn.
- The transcript shows evidence of OpenClaw-like continuity behavior:
  - either tool call `openclaw_read_history`, or
  - a write to the daily note path `memory/YYYY-MM-DD.md`
- The gateway log does not contain delivery-failure evidence.

Recommended concrete checks:

- Session discovery:
  - `sessions.count` increases, or a new session key appears
  - selected session row has `updatedAt >= startedAt`
- Transcript:
  - header line parses successfully
  - last assistant text is non-empty
  - transcript does not end on a dangling tool call without assistant completion
- Behavior evidence:
  - `toolCalls.some(call => call.name === "openclaw_read_history")`
  - or `filesWritten.some(path => /(^|\/)memory\/\d{4}-\d{2}-\d{2}\.md$/.test(path))`
- Log cleanliness:
  - must not match `/delivery failed/i`
  - must not match `/Channel is required when delivery\.channel=last has no previous channel/i`
  - must not match `/unknown account/i`

Optional but useful secondary assertions:

- `payload.kind` from cron-add output is `agentTurn`
- the discovered session is distinct from the main session
- assistant text is not exactly `NO_REPLY`

# 6. Required CLAUDE.md / Context Patches

Minimum patch set for Track G:

1. Reply directive determinism in `src/agents/acp-workspace-context.ts`

- Strengthen Output Directives so `[[reply_to_current]]` must be the first token when the assistant intends to reply in the originating conversation.
- Reason: makes reply directives machine-detectable and avoids model drift in background turns.

2. Background-run boundedness

- Add an explicit rule that the agent must not poll spawned subagents in a loop.
- Reason: cron runs must terminate cleanly instead of stalling on repeated status checks.

3. ACP routing rule

- Add guidance that requests phrased like “do this in Claude Code” or “handle this in Claude Code” should route to ACP runtime work rather than generic subagent delegation.
- Reason: prevents the cron job from bouncing work to the wrong execution path.

Conditional heartbeat wording, only if the implementation expands this track to an explicit heartbeat hop:

- exact `HEARTBEAT_OK` rule
- quiet-hours suppression rule for `23:00-08:00`
- `HEARTBEAT.md` interval-check wording

Not required for the exact cron `--message` flow unless the live run proves otherwise:

- persona inlining from `SOUL.md`
- main-vs-shared `MEMORY.md` rule

Unit tests to add in `src/agents/acp-workspace-context.test.ts`:

- output directives mention first-token `[[reply_to_current]]`
- generated guidance forbids subagent polling loops
- generated guidance includes ACP-vs-subagent routing text
- if heartbeat wording is added here, assert `HEARTBEAT_OK`, quiet-hours, and interval-check text explicitly

# 7. Script and Test Wiring

Files to implement or update:

- `.planning/acp-e2e/track-g-cron-roundtrip.md`
- `scripts/e2e/acp-cli/tests/cron-roundtrip.e2e.ts`
- `scripts/e2e/acp-cli/driver.ts`
- `scripts/e2e/acp-cli/transcript.ts` if per-turn helpers are still missing
- `scripts/run-acp-cli-evals.mjs`
- `package.json`
- `src/agents/acp-workspace-context.ts`
- `src/agents/acp-workspace-context.test.ts`

Driver structure for `cron-roundtrip.e2e.ts`:

- call `addCron()`
- call `runCron()`
- resolve new session via `waitForNewSession()`
- read transcript
- read gateway log
- run assertions
- remove cron job in `finally`

`package.json` wiring:

- add `test:e2e:acp:g`
  - `node scripts/run-acp-cli-evals.mjs --track=g`

Live gating:

- only run when `LIVE=1`
- skip with exit 0 otherwise
- keep Track G out of default `pnpm test`
- intended usage:
  - nightly lane
  - pre-release lane

# 8. Failure Modes

Infra failures:

- `openclaw cron add` or `openclaw cron run` exits non-zero
- CLI JSON cannot be parsed
- no new session appears within timeout
- transcript file for discovered session is missing
- gateway log shows auth, transport, or delivery resolution failure

Agent-behavior failures:

- session exists, but no completed assistant turn appears
- transcript is tool-only or ends mid-turn
- assistant completes but neither reads history nor writes a daily note
- assistant returns `NO_REPLY` when a visible summary was expected

How to classify them in assertions:

- `cron add/run` command failure: infra
- session discovery timeout with clean cron CLI output: infra
- missing transcript file for a listed session: infra/session-store
- transcript exists with refusal/error-only assistant output: agent/runtime behavior
- transcript exists with completed reply but no memory/history evidence: agent behavior
- clean transcript plus delivery-failure log line: infra/configuration, not agent behavior

The test should report these separately so failures are actionable:

- `infra:cron-add`
- `infra:cron-run`
- `infra:session-discovery`
- `infra:transcript-missing`
- `infra:delivery`
- `behavior:assistant-turn`
- `behavior:memory-or-history`

# 9. Acceptance Criteria

Implementation is complete when all of the following are true:

- `scripts/e2e/acp-cli/tests/cron-roundtrip.e2e.ts` exists and uses only native CLI surfaces.
- The test reuses Track 0 harness code instead of introducing a parallel bootstrap path.
- The test discovers the cron-created session via `openclaw sessions --agent claude --json`.
- The test reads the authoritative transcript JSONL from disk and asserts against it.
- The test inspects the real gateway log and rejects delivery failures.
- `src/agents/acp-workspace-context.test.ts` covers any new generated `CLAUDE.md` rules added for Track G.
- `LIVE=1 pnpm test:e2e:acp:g` passes in an environment with valid ACP auth and runtime availability.
- Without `LIVE=1`, the Track G script skips cleanly.

# 10. Open Questions

1. Should Track G keep the exact provided `--message` flow, or should it be split into:
   - `G1`: cron isolated agent-turn round-trip
   - `G2`: cron main-session system-event heartbeat round-trip

2. Should the plan codify the current CLI syntax correction now?
   - current repo requires `--name daily-summary`
   - current repo requires `cron run <jobId>`, not `cron run <name>`

3. What is the shared Track 0 delivery fixture for default announce jobs?
   - loopback/test channel
   - seeded previous-session target
   - something else already in progress

4. If the live model succeeds without the conditional heartbeat prompt rules, should those remain deferred to a heartbeat-specific track instead of being bundled into Track G?
