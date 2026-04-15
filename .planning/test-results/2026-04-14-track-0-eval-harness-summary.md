# 2026-04-14 Track 0 Eval Harness Summary

## Scope

Implemented the prompt-specified Track 0 ACP eval harness under `src/acp/eval/` plus `scripts/run-acp-evals.mjs`.

Important mismatch:

- The checked-in planning doc in this repo is `.planning/acp-e2e/track-0-cli-harness.md`.
- That plan describes a black-box native CLI harness under `scripts/e2e/acp-cli/`.
- The user request for this task instead specified a shared `src/acp/eval/*` mock/live harness with composable transcript rules.
- This result follows the user request, not the current checked-in CLI-harness plan.

## Changes

- Added `src/acp/eval/harness.ts`
  - `runEval({ prompt, sessionSeed, mode })`
  - deterministic `mock` path with scripted tool calls
  - gated `live` path wired for `claude-code-acp --mcp-server=openclaw-agent-serve`
  - seeded workspace creation and transcript normalization
- Added `src/acp/eval/rules.ts`
  - `mustCallTool`
  - `mustNotCallTool`
  - `replyMatches`
  - `replyIsExact`
  - `calledInOrder`
  - `readBootstrapFiles`
  - `assertRules`
- Added seeded fixture workspace under `src/acp/eval/fixtures/workspace/`
- Added `scripts/run-acp-evals.mjs`
  - `mock` vs `live` split
  - `serve-mcp` subcommand for the live MCP wrapper
- Added `src/acp/eval/harness.test.ts`
- Added a small gateway-caller injection seam to `src/mcp/openclaw-agent-serve.ts`
- Exported `buildClaudeMdContent()` from `src/agents/acp-workspace-context.ts`

## Verification

Passed:

- `pnpm test src/acp/eval/harness.test.ts src/mcp/openclaw-agent-serve.test.ts`
- `node --import tsx scripts/run-acp-evals.mjs --mode mock --session-seed track-0-cli --prompt 'Send a short acknowledgement.' --final-reply 'Acknowledged.'`
- `node --import tsx scripts/run-acp-evals.mjs --mode live --session-seed track-0-live-skip`
  - expected output: `skipped: LIVE=1 not set`

Observed during verification:

- `ensureAcpWorkspaceContext()` behaved normally under Vitest but hung in a plain Node/tsx runner path.
- The harness now writes the same generated `CLAUDE.md` content and session context file directly to avoid that runtime issue in the eval runner.

Not completed:

- Real `live` run was not executed.
  - `LIVE=1` was not set during verification.
  - `claude-code-acp` is not installed in this environment (`command not found`).
- `pnpm tsgo` was started as a broader gate but terminated after running long without producing harness-specific signal. No harness-specific type/test failures were surfaced before termination.

## Readiness

Mock mode:

- Ready and directly exercised.

Live mode:

- Structurally wired and skip-gated.
- Still blocked on environment readiness:
  - `LIVE=1`
  - install or provide `claude-code-acp`
  - valid Claude ACP auth in the runtime environment
