# ACP Track E/F

- Task: Added native ACP CLI E2E coverage scaffolding for Track E directives and Track F session lifecycle, wired `pnpm test:e2e:acp:e` / `pnpm test:e2e:acp:f`, patched workspace prompt rules, tightened `openclaw_session_close` no-target behavior, and added CLI `--thread-parent` support.
- Tests run:
  - `pnpm test src/agents/acp-workspace-context.test.ts src/mcp/openclaw-agent-serve.test.ts src/commands/agent-via-gateway.test.ts src/cli/program/register.agent.test.ts` — Passed
  - `pnpm test:e2e:acp:e` — Passed as gated skip (`LIVE` not set)
  - `pnpm test:e2e:acp:f` — Passed as gated skip (`LIVE` not set)
  - `pnpm build` — Failed
- Important issues / follow-up:
  - Real live Track E/F runs were not executed in this shell because `LIVE=1` was not set and `claude-code-acp` was not available.
  - `pnpm build` failed on a pre-existing unrelated error: `src/agents/cli-runner/execute.ts(478,185): Cannot find name 'managedRun'.`
