# Track 0 — Native-CLI E2E Harness

**Owner:** one Codex agent. Blocking prerequisite for Tracks A–H.

## Goal

Build the shared shell + TypeScript harness that every behavior track uses to:

1. Boot a real `openclaw gateway` on a scratch `OPENCLAW_HOME` + scratch port.
2. Seed a deterministic workspace (AGENTS.md, SOUL.md, IDENTITY.md, HEARTBEAT.md, minimal MEMORY.md, `openclaw.json`).
3. Drive prompts via native CLI (`openclaw agent --message ... --json`).
4. Read the resulting session JSONL transcript from disk.
5. Assert behavior rules (tool calls, reply text, files read/written) with composable matchers.

No in-process mocks. Every run is black-box over the real CLI + real gateway + real ACPX runtime.

## Context

- Master plan: `/Users/sasha/.claude/plans/atomic-seeking-cherny.md`.
- Pattern to mirror: `scripts/e2e/mcp-channels-docker.sh` + `scripts/e2e/mcp-channels-harness.ts` (boot/wait/connect). Reuse their helpers wherever possible.
- CLI surface confirmed via research:
  - `openclaw gateway run --port <p> --bind loopback --allow-unconfigured` (background).
  - `openclaw agent --message <text> --agent <id> --session-id <id> --deliver --json` → prints `{payloads, sessionId, ...}`.
  - `openclaw sessions [--agent <id>] --json`.
  - `openclaw system event --mode now --text <text>` (heartbeat trigger).
  - `openclaw cron add|list|run|remove`.
- Session transcripts live on disk at `$OPENCLAW_HOME/agents/<agentId>/sessions/<sessionId>.jsonl` (header line + message lines).

## Deliverables

All under `scripts/e2e/acp-cli/`:

1. **`harness.sh`** — boots and tears down the gateway.
   - Mint `OPENCLAW_HOME=$(mktemp -d -t openclaw-e2e.XXXXXX)`.
   - Pick a free port (scan starting at 18900).
   - Seed fixtures from `fixtures/` into `$OPENCLAW_HOME/` (config + bootstrap files).
   - `openclaw gateway run --port $PORT --bind loopback --allow-unconfigured > $OPENCLAW_HOME/gateway.log 2>&1 &`
   - Wait for TCP readiness (poll `nc -z 127.0.0.1 $PORT`, ~30s max, 200 ms interval).
   - Export: `OPENCLAW_HOME`, `OPENCLAW_GATEWAY_URL=ws://127.0.0.1:$PORT`, `OPENCLAW_GATEWAY_TOKEN` (read from scratch config).
   - Run the TS test file passed as `$1` via `bun` (or `pnpm tsx`, match repo preference — see `scripts/e2e/mcp-channels-docker.sh`).
   - On exit (trap EXIT): kill gateway, dump `gateway.log` + last failed session JSONL to stderr if exit code non-zero, `rm -rf $OPENCLAW_HOME` unless `E2E_KEEP_TMP=1`.

2. **`driver.ts`** — typed wrappers around CLI. Minimum surface:

   ```ts
   export type SendArgs = {
     message: string;
     sessionId: string;
     agent: string;
     channel?: string;
     accountId?: string;
     threadParent?: string;
     deliver?: boolean; // default true
   };
   export type SendResult = {
     sessionId: string;
     payloads: Array<{ text?: string; media?: string }>;
     stopReason?: string;
     raw: unknown;
   };
   export function sendMessage(args: SendArgs): Promise<SendResult>;
   export function listSessions(agent?: string): Promise<SessionEntry[]>;
   export function triggerHeartbeat(text?: string): Promise<void>;
   export function addCron(args: {
     name: string;
     every: string;
     message: string;
     agent: string;
   }): Promise<void>;
   export function runCron(name: string): Promise<void>;
   export function removeCron(name: string): Promise<void>;
   ```

   Each helper `execFile`s the `openclaw` binary resolved from `process.env.OPENCLAW_BIN ?? "openclaw"`. JSON output parsed with `zod` for safety.

3. **`transcript.ts`** — JSONL parser.

   ```ts
   export type ToolCall = {
     name: string; // e.g. "openclaw_reply", "Read", "Write"
     args: Record<string, unknown>;
     result?: unknown;
     turnIndex: number;
   };
   export type ParsedTranscript = {
     sessionId: string;
     header: { id: string; version: number; createdAt: number };
     messages: Array<{
       role: "user" | "assistant" | "tool";
       text?: string;
       turnIndex: number;
       timestamp: number;
     }>;
     toolCalls: ToolCall[];
     filesRead: string[]; // any Read tool or equivalent (dedup'd, in order)
     filesWritten: string[]; // any Write/Edit tool (dedup'd, in order)
     assistantText: string; // concatenation of assistant text parts from last turn
     allAssistantText: string; // across all turns
   };
   export function readTranscript(sessionId: string, opts?: { agent?: string }): ParsedTranscript;
   ```

   Resolves file path from `$OPENCLAW_HOME/agents/<agent>/sessions/<sessionId>.jsonl` (agent defaults to sniffing from `openclaw sessions --json`).

4. **`rules.ts`** — matcher combinators. Each returns `{ ok: boolean, message: string }`. Composable. Minimum set:

   ```ts
   mustCallTool(name: string, argsMatcher?: (args: any) => boolean): Rule;
   mustNotCallTool(name: string): Rule;
   callCountAtMost(name: string, n: number): Rule;
   replyIsExact(regex: RegExp): Rule;
   replyMatches(regex: RegExp): Rule;
   replyNotMatches(regex: RegExp): Rule;
   calledInOrder(names: string[]): Rule;
   readBootstrapFiles(names: string[]): Rule;   // all present in filesRead before first assistant text
   wroteFileMatching(pathRegex: RegExp, contentRegex?: RegExp): Rule;
   ```

   A tiny runner `assertRules(transcript, rules[])` that throws on first failure with a readable diff (which rules failed, transcript summary).

5. **`fixtures/`** — seeded workspace:
   - `openclaw.json` — minimal config: ACPX backend enabled, `acp.defaultAgent: "claude"`, `acp.dispatch.enabled: true`, no real channels except a loopback/test channel for `--deliver` target, a dummy `gateway.token` string.
   - `workspace/AGENTS.md` — boilerplate OpenClaw agent guide (can start from `docs/reference/templates/AGENTS.md`).
   - `workspace/SOUL.md` — short persona: "genuine, opinionated, no corporate filler."
   - `workspace/IDENTITY.md` — `name: "Skredik", emoji: "🦞"`.
   - `workspace/HEARTBEAT.md` — blank by default; tracks will rewrite per case.
   - `workspace/MEMORY.md` — blank.
   - `workspace/TOOLS.md` — optional reference.
   - `agents/claude/sessions/` — empty (harness creates).

6. **`scripts/run-acp-cli-evals.mjs`** — entrypoint. Accepts `--track=<letter>` or `--all`, resolves the matching `.e2e.ts` file(s), invokes `harness.sh` per file, aggregates exit codes, prints summary. Respects `LIVE=1` gate — without it, print a skip notice and exit 0.

7. **`package.json` scripts:**

   ```jsonc
   {
     "test:e2e:acp:harness-smoke": "node scripts/run-acp-cli-evals.mjs --track=0",
     "test:e2e:acp:a": "node scripts/run-acp-cli-evals.mjs --track=a",
     "test:e2e:acp:b": "node scripts/run-acp-cli-evals.mjs --track=b",
     "test:e2e:acp:c": "node scripts/run-acp-cli-evals.mjs --track=c",
     "test:e2e:acp:d": "node scripts/run-acp-cli-evals.mjs --track=d",
     "test:e2e:acp:e": "node scripts/run-acp-cli-evals.mjs --track=e",
     "test:e2e:acp:f": "node scripts/run-acp-cli-evals.mjs --track=f",
     "test:e2e:acp:g": "node scripts/run-acp-cli-evals.mjs --track=g",
     "test:e2e:acp:all": "node scripts/run-acp-cli-evals.mjs --all",
   }
   ```

8. **Harness smoke test** (`scripts/e2e/acp-cli/tests/harness.smoke.e2e.ts`):
   - Boot gateway, `sendMessage({agent: "claude", sessionId: "smoke-1", message: "ping"})`, read transcript, assert at least one assistant message came back and the session file exists. No behavior assertions — this just proves the harness itself works end-to-end.

## Critical Files to Reference

- `scripts/e2e/mcp-channels-docker.sh` — copy boot/wait/cleanup structure.
- `scripts/e2e/mcp-channels-harness.ts` — copy gateway-connect helpers if needed.
- `scripts/e2e/mcp-channels-seed.ts` — copy seed-file writing pattern.
- `src/commands/` — inspect the `agent`, `sessions`, `gateway`, `cron`, `system` commands for exact flag surface.
- `src/mcp/openclaw-agent-serve.ts` — tool names you'll assert against in tracks.

## Constraints

- **LIVE=1 gated.** Harness refuses to run without `LIVE=1` and a valid Claude Code ACP API key env var. Print clear skip message.
- **No new prod deps.** Use `execa`/`node:child_process`/`zod` only if already in devDependencies.
- **No global state.** Each run must be fully scoped to its scratch `OPENCLAW_HOME`.
- **Don't touch `.github/workflows/*`.**
- **Gateway log preserved on failure.** Delete only on success (unless `E2E_KEEP_TMP=1`).

## Verification

1. `LIVE=1 pnpm test:e2e:acp:harness-smoke` → green. Smoke test boots gateway, sends one prompt, reads transcript, passes.
2. Without `LIVE=1`: `pnpm test:e2e:acp:harness-smoke` → prints "skipped: LIVE=1 not set" and exits 0.
3. `pnpm check` stays green — harness code under `scripts/` shouldn't introduce lint/type errors.
4. Failure mode: artificially break fixture, rerun, confirm harness prints `gateway.log` tail + failing session JSONL tail.

## Out of scope

- Behavior evals — those are Tracks A–H.
- Mock-mode runners — not needed; live is the contract.
- CI wiring — someone else wires this to a nightly lane later.
