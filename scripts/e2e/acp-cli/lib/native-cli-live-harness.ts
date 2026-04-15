import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  resolveCliBackendConfig,
  resolveCliBackendLiveTest,
} from "../../../../src/agents/cli-backends.js";
import {
  isToolCallBlock,
  isToolResultBlock,
  resolveToolBlockArgs,
  resolveToolUseId,
  type ToolContentBlock,
} from "../../../../src/chat/tool-content.js";
import type { SessionEntry } from "../../../../src/config/sessions/types.js";
import {
  readClaudeCliSessionMessages,
  resolveClaudeCliBindingSessionId,
} from "../../../../src/gateway/cli-session-history.claude.js";
import { readSessionMessages } from "../../../../src/gateway/session-utils.fs.js";
import { extractAssistantVisibleText } from "../../../../src/shared/chat-message-content.js";
import { getFreePortBlockWithPermissionFallback } from "../../../../src/test-utils/ports.js";

const execFileAsync = promisify(execFile);
const FIXTURE_WORKSPACE_ROOT = new URL(
  "../../../../src/acp/eval/fixtures/workspace/",
  import.meta.url,
);
const GATEWAY_DRIVER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "gateway-driver.sh",
);

const DEFAULT_TIMEOUT_MS = 240_000;
const TURN_TIMEOUT_SECONDS = 180;
const CLAUDE_CLI_PROVIDER = "claude-cli";
const DEFAULT_CLAUDE_CLI_MODEL =
  resolveCliBackendLiveTest(CLAUDE_CLI_PROVIDER)?.defaultModelRef ?? "claude-cli/claude-sonnet-4-6";

export type NativeCliHarness = {
  agentId: string;
  agentIds: string[];
  cliEnv: NodeJS.ProcessEnv;
  configPath: string;
  gatewayLogPath: string;
  homeDir: string;
  pidPath: string;
  port: number;
  rootDir: string;
  sessionStorePath: string;
  stateDir: string;
  token: string;
  workspaceDir: string;
  workspaceDirs: Record<string, string>;
};

export type NativeCliResponse = {
  result?: {
    payloads?: Array<{
      text?: string;
      mediaUrl?: string | null;
      mediaUrls?: string[];
    }>;
  };
  status?: string;
  summary?: string;
};

export type ClaudeToolCall = {
  args: unknown;
  messageIndex: number;
  name: string;
  result: unknown;
  toolUseId?: string;
};

export type ClaudeSessionSnapshot = {
  cliSessionId: string;
  entry: SessionEntry;
  localTranscriptPath?: string;
  messages: unknown[];
  sessionKey: string;
  toolCalls: ClaudeToolCall[];
};

export type OpenClawTranscriptToolCall = {
  args: unknown;
  messageIndex: number;
  name: string;
  toolUseId?: string;
};

export type OpenClawTranscriptSnapshot = {
  agentId: string;
  assistantText: string;
  assistantTexts: string[];
  entry: SessionEntry;
  localTranscriptPath?: string;
  messages: unknown[];
  sessionId: string;
  sessionKey: string;
  toolCalls: OpenClawTranscriptToolCall[];
};

type NativeCliHarnessAgent = {
  command?: string;
  id: string;
  name?: string;
  workspaceFiles?: Record<string, string>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAgentCommand(): string {
  const command =
    process.env.OPENCLAW_E2E_ACP_CLAUDE_COMMAND?.trim() ||
    process.env.OPENCLAW_ACP_EVAL_LIVE_COMMAND?.trim() ||
    process.env.OPENCLAW_LIVE_ACP_BIND_AGENT_COMMAND?.trim() ||
    "claude-code-acp --mcp-server=openclaw-agent-serve";
  return command;
}

function stripClaudeSettingSourcesArgs(args?: string[]): string[] | undefined {
  if (!Array.isArray(args)) {
    return args;
  }
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--setting-sources") {
      const maybeValue = args[index + 1];
      if (typeof maybeValue === "string" && !maybeValue.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--setting-sources=")) {
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

async function ensureExecutable(filePath: string): Promise<void> {
  await fs.chmod(filePath, 0o755);
}

async function copyFixtureWorkspace(destinationDir: string): Promise<void> {
  await fs.mkdir(destinationDir, { recursive: true });
  await fs.cp(FIXTURE_WORKSPACE_ROOT, destinationDir, { recursive: true });
}

export async function createNativeCliHarness(params?: {
  agentId?: string;
  agents?: NativeCliHarnessAgent[];
  primaryAgentId?: string;
  trackName?: string;
}): Promise<NativeCliHarness> {
  const trackName = params?.trackName?.trim() || "track-d";
  const configuredAgents = params?.agents?.filter((agent) => agent.id.trim().length > 0) ?? [];
  const agents =
    configuredAgents.length > 0
      ? configuredAgents
      : [
          {
            id: params?.agentId?.trim() || "claude",
          },
        ];
  const agentIds = agents.map((agent) => agent.id.trim());
  const agentId =
    params?.primaryAgentId?.trim() || params?.agentId?.trim() || agentIds[0] || "claude";
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-acp-cli-${trackName}-`));
  const homeDir = path.join(rootDir, "home");
  const configDir = path.join(homeDir, ".openclaw");
  const configPath = path.join(configDir, "openclaw.json");
  const stateDir = path.join(configDir, "state");
  const sessionStorePath = path.join(rootDir, "sessions.json");
  const gatewayLogPath = path.join(rootDir, "gateway.log");
  const pidPath = path.join(rootDir, "gateway.pid");
  const port = await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 42_000,
  });
  const token = `acp-cli-${randomUUID()}`;

  await fs.mkdir(configDir, { recursive: true });
  const workspaceDirs = Object.fromEntries(
    agents.map((agent) => [agent.id, path.join(rootDir, "workspace", agent.id)]),
  );
  for (const agent of agents) {
    const workspaceDir = workspaceDirs[agent.id];
    await copyFixtureWorkspace(workspaceDir);
    for (const [filename, content] of Object.entries(agent.workspaceFiles ?? {})) {
      await fs.writeFile(path.join(workspaceDir, filename), content, "utf-8");
    }
  }

  const claudeCliBackend = resolveCliBackendConfig(CLAUDE_CLI_PROVIDER);
  assert.ok(
    claudeCliBackend?.config.command,
    `${CLAUDE_CLI_PROVIDER} backend defaults are required for ACP CLI live tests`,
  );
  const claudeCliArgs = stripClaudeSettingSourcesArgs(claudeCliBackend.config.args);
  const claudeCliResumeArgs = stripClaudeSettingSourcesArgs(claudeCliBackend.config.resumeArgs);

  const config = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token },
      controlUi: { enabled: false },
    },
    session: {
      mainKey: "main",
      store: sessionStorePath,
    },
    acp: {
      enabled: true,
      backend: "acpx",
      defaultAgent: agentId,
      allowedAgents: [...new Set(agentIds)],
      dispatch: { enabled: true },
    },
    agents: {
      list: agents.map((agent) => ({
        id: agent.id,
        name: agent.name ?? (agent.id === "claude" ? "Claude" : agent.id),
        workspace: workspaceDirs[agent.id],
      })),
      defaults: {
        model: { primary: DEFAULT_CLAUDE_CLI_MODEL },
        models: { [DEFAULT_CLAUDE_CLI_MODEL]: {} },
        cliBackends: {
          [CLAUDE_CLI_PROVIDER]: {
            command: claudeCliBackend.config.command,
            ...(Array.isArray(claudeCliArgs) ? { args: [...claudeCliArgs] } : {}),
            ...(Array.isArray(claudeCliResumeArgs) ? { resumeArgs: [...claudeCliResumeArgs] } : {}),
            ...(Array.isArray(claudeCliBackend.config.clearEnv)
              ? { clearEnv: [...claudeCliBackend.config.clearEnv] }
              : {}),
            ...(claudeCliBackend.config.env ? { env: { ...claudeCliBackend.config.env } } : {}),
            ...(claudeCliBackend.config.systemPromptWhen
              ? { systemPromptWhen: claudeCliBackend.config.systemPromptWhen }
              : {}),
          },
        },
        sandbox: { mode: "off" },
      },
    },
    plugins: {
      entries: {
        acpx: {
          enabled: true,
          config: {
            openClawAgentMcp: true,
            permissionMode: "approve-all",
            nonInteractivePermissions: "deny",
            agents: Object.fromEntries(
              agents.map((agent) => [
                agent.id,
                {
                  command: agent.command ?? resolveAgentCommand(),
                },
              ]),
            ),
          },
        },
      },
    },
  };

  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  await ensureExecutable(GATEWAY_DRIVER_PATH);

  return {
    agentId,
    agentIds,
    cliEnv: {
      ...process.env,
      OPENCLAW_HOME: homeDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_URL: `ws://127.0.0.1:${port}`,
      OPENCLAW_STATE_DIR: stateDir,
    },
    configPath,
    gatewayLogPath,
    homeDir,
    pidPath,
    port,
    rootDir,
    sessionStorePath,
    stateDir,
    token,
    workspaceDir: workspaceDirs[agentId],
    workspaceDirs,
  };
}

export async function startNativeCliGateway(harness: NativeCliHarness): Promise<void> {
  await execFileAsync(
    "bash",
    [
      GATEWAY_DRIVER_PATH,
      "start",
      harness.homeDir,
      harness.configPath,
      harness.stateDir,
      String(harness.port),
      harness.token,
      harness.gatewayLogPath,
      harness.pidPath,
    ],
    {
      cwd: process.cwd(),
      env: harness.cliEnv,
    },
  );
  await waitForPortOpen(harness.port, harness.gatewayLogPath);
}

export async function stopNativeCliGateway(harness: NativeCliHarness): Promise<void> {
  await execFileAsync("bash", [GATEWAY_DRIVER_PATH, "stop", harness.pidPath], {
    cwd: process.cwd(),
    env: harness.cliEnv,
  }).catch(() => undefined);
}

export async function destroyNativeCliHarness(harness: NativeCliHarness): Promise<void> {
  await stopNativeCliGateway(harness);
  await fs.rm(harness.rootDir, { recursive: true, force: true });
}

async function waitForPortOpen(port: number, gatewayLogPath: string): Promise<void> {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const opened = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const finish = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1_000, () => finish(false));
    });
    if (opened) {
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `timeout waiting for gateway on port ${String(port)}\n${await readGatewayLogTail(gatewayLogPath)}`,
  );
}

async function runNativeOpenClawJson<T>(args: string[], env: NodeJS.ProcessEnv): Promise<T> {
  const childEnv = { ...env };
  delete childEnv.VITEST;
  delete childEnv.VITEST_MODE;
  delete childEnv.VITEST_POOL_ID;
  delete childEnv.VITEST_WORKER_ID;
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(process.execPath, ["openclaw.mjs", ...args], {
      cwd: process.cwd(),
      env: childEnv,
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const record = error as { stdout?: unknown; stderr?: unknown };
    stdout = typeof record.stdout === "string" ? record.stdout : "";
    stderr = typeof record.stderr === "string" ? record.stderr : "";
    if (!stdout.trim()) {
      throw error;
    }
  }
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(
      [
        `openclaw ${args.join(" ")} produced no JSON stdout`,
        stderr.trim() ? `stderr: ${stderr.trim()}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (error) {
    throw new Error(
      [
        `openclaw ${args.join(" ")} returned invalid JSON`,
        `stdout: ${trimmed}`,
        stderr.trim() ? `stderr: ${stderr.trim()}` : undefined,
        error instanceof Error ? `cause: ${error.message}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      { cause: error },
    );
  }
}

function listSessionStoreMatches(params: {
  store: Record<string, SessionEntry>;
  agentId?: string;
  sessionId: string;
}): Array<[string, SessionEntry]> {
  return Object.entries(params.store).filter(([key, entry]) => {
    if (entry?.sessionId !== params.sessionId) {
      return false;
    }
    if (!params.agentId) {
      return true;
    }
    return key.startsWith(`agent:${params.agentId}:`);
  });
}

function resolveSessionStoreMatch(params: {
  store: Record<string, SessionEntry>;
  agentId?: string;
  sessionId: string;
}): [string, SessionEntry] | null {
  const matches = listSessionStoreMatches(params);
  return matches[0] ?? null;
}

export async function runNativeAgentTurn(params: {
  agentId?: string;
  extraArgs?: string[];
  harness: NativeCliHarness;
  message: string;
  sessionId: string;
}): Promise<NativeCliResponse> {
  try {
    return await runNativeOpenClawJson<NativeCliResponse>(
      [
        "agent",
        "--agent",
        params.agentId ?? params.harness.agentId,
        "--session-id",
        params.sessionId,
        "--deliver",
        "--json",
        "--timeout",
        String(TURN_TIMEOUT_SECONDS),
        ...(params.extraArgs ?? []),
        "--message",
        params.message,
      ],
      params.harness.cliEnv,
    );
  } catch (error) {
    // Live assertions are transcript-driven. Preserve late CLI cleanup noise without
    // hiding the run from the caller; the follow-up transcript wait will decide success.
    return {
      status: "cli_error",
      summary: error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  }
}

async function readSessionStore(sessionStorePath: string): Promise<Record<string, SessionEntry>> {
  try {
    return JSON.parse(await fs.readFile(sessionStorePath, "utf-8")) as Record<string, SessionEntry>;
  } catch {
    return {};
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeToolResultContent(value: unknown): unknown {
  if (typeof value === "string") {
    return parseMaybeJson(value);
  }
  if (!Array.isArray(value)) {
    return value;
  }
  const text = value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      if ("text" in entry && typeof entry.text === "string") {
        return entry.text;
      }
      if ("content" in entry && typeof entry.content === "string") {
        return entry.content;
      }
      return "";
    })
    .join("")
    .trim();
  return text ? parseMaybeJson(text) : value;
}

export function collectClaudeToolCalls(messages: unknown[]): ClaudeToolCall[] {
  const calls: ClaudeToolCall[] = [];
  messages.forEach((message, messageIndex) => {
    if (!message || typeof message !== "object") {
      return;
    }
    if ((message as { role?: unknown }).role !== "assistant") {
      return;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return;
    }

    const resultById = new Map<string, unknown>();
    for (const block of content) {
      if (!block || typeof block !== "object" || !isToolResultBlock(block as ToolContentBlock)) {
        continue;
      }
      const toolUseId = resolveToolUseId(block as ToolContentBlock);
      if (!toolUseId) {
        continue;
      }
      resultById.set(
        toolUseId,
        normalizeToolResultContent((block as { content?: unknown }).content),
      );
    }

    for (const block of content) {
      if (!block || typeof block !== "object" || !isToolCallBlock(block as ToolContentBlock)) {
        continue;
      }
      const toolBlock = block as ToolContentBlock;
      const toolUseId = resolveToolUseId(toolBlock);
      calls.push({
        args: resolveToolBlockArgs(toolBlock),
        messageIndex,
        name: typeof toolBlock.name === "string" ? toolBlock.name : "",
        result: toolUseId ? resultById.get(toolUseId) : undefined,
        ...(toolUseId ? { toolUseId } : {}),
      });
    }
  });
  return calls;
}

export async function waitForClaudeSessionSnapshot(
  harness: NativeCliHarness,
  sessionId: string,
  predicate: (snapshot: ClaudeSessionSnapshot) => boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ClaudeSessionSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: ClaudeSessionSnapshot | null = null;
  const requestedSessionKey = `agent:${harness.agentId}:${sessionId}`;

  while (Date.now() < deadline) {
    const snapshot = await readClaudeSessionSnapshot(harness, {
      agentId: harness.agentId,
      sessionId,
    });
    if (snapshot) {
      lastSnapshot = snapshot;
      if (predicate(snapshot)) {
        return snapshot;
      }
    }
    await sleep(500);
  }

  throw new Error(
    [
      `timed out waiting for Claude session snapshot (${requestedSessionKey})`,
      lastSnapshot ? formatSnapshot(lastSnapshot) : "no snapshot available yet",
      await readGatewayLogTail(harness.gatewayLogPath),
    ].join("\n\n"),
  );
}

async function readClaudeSessionSnapshot(
  harness: NativeCliHarness,
  params: { agentId?: string; sessionId: string },
): Promise<ClaudeSessionSnapshot | null> {
  const store = await readSessionStore(harness.sessionStorePath);
  const match = resolveSessionStoreMatch({
    store,
    agentId: params.agentId,
    sessionId: params.sessionId,
  });
  if (!match) {
    return null;
  }
  const [sessionKey, entry] = match;
  const cliSessionId = resolveClaudeCliBindingSessionId(entry);
  if (!cliSessionId) {
    return null;
  }
  const messages = readClaudeCliSessionMessages({ cliSessionId });
  const toolCalls = collectClaudeToolCalls(messages);
  return {
    cliSessionId,
    entry,
    ...(typeof entry.sessionFile === "string" ? { localTranscriptPath: entry.sessionFile } : {}),
    messages,
    sessionKey,
    toolCalls,
  };
}

function formatSnapshot(snapshot: ClaudeSessionSnapshot): string {
  const toolSummary =
    snapshot.toolCalls.map((call) => `${call.name} ${JSON.stringify(call.args)}`).join("\n") ||
    "<none>";
  return [
    `sessionKey: ${snapshot.sessionKey}`,
    `cliSessionId: ${snapshot.cliSessionId}`,
    `localTranscriptPath: ${snapshot.localTranscriptPath ?? "<none>"}`,
    `toolCalls:\n${toolSummary}`,
  ].join("\n");
}

export async function readGatewayLogTail(gatewayLogPath: string, lineCount = 120): Promise<string> {
  try {
    const content = await fs.readFile(gatewayLogPath, "utf-8");
    const lines = content.trim().split(/\r?\n/);
    return lines.slice(-lineCount).join("\n");
  } catch {
    return "<gateway log unavailable>";
  }
}

function matchesToolName(actualName: string, expectedName: string): boolean {
  return actualName === expectedName || actualName.endsWith(`__${expectedName}`);
}

export function getToolCallsByName(
  snapshot: ClaudeSessionSnapshot,
  name: string,
): ClaudeToolCall[] {
  return snapshot.toolCalls.filter((call) => matchesToolName(call.name, name));
}

function collectOpenClawTranscriptToolCalls(messages: unknown[]): OpenClawTranscriptToolCall[] {
  const calls: OpenClawTranscriptToolCall[] = [];
  messages.forEach((message, messageIndex) => {
    if (!message || typeof message !== "object") {
      return;
    }
    if ((message as { role?: unknown }).role !== "assistant") {
      return;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return;
    }
    for (const block of content) {
      if (!block || typeof block !== "object" || !isToolCallBlock(block as ToolContentBlock)) {
        continue;
      }
      const toolBlock = block as ToolContentBlock;
      calls.push({
        args: resolveToolBlockArgs(toolBlock),
        messageIndex,
        name: typeof toolBlock.name === "string" ? toolBlock.name : "",
        ...(resolveToolUseId(toolBlock) ? { toolUseId: resolveToolUseId(toolBlock) } : {}),
      });
    }
  });
  return calls;
}

export async function seedNativeCliSession(params: {
  harness: NativeCliHarness;
  agentId?: string;
  messages?: Array<{ role: "user" | "assistant" | "system"; text: string }>;
  sessionId: string;
  sessionKey?: string;
}): Promise<{ sessionFile: string; sessionKey: string }> {
  const agentId = params.agentId ?? params.harness.agentId;
  const sessionKey = params.sessionKey ?? `agent:${agentId}:main`;
  const sessionFile = path.join(
    params.harness.stateDir,
    "agents",
    agentId,
    "sessions",
    `${params.sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(
    sessionFile,
    buildTranscriptLines(params.sessionId, params.messages ?? []),
    "utf-8",
  );

  const store = await readSessionStore(params.harness.sessionStorePath);
  store[sessionKey] = {
    sessionId: params.sessionId,
    sessionFile,
    updatedAt: Date.now(),
  };
  await fs.writeFile(
    params.harness.sessionStorePath,
    `${JSON.stringify(store, null, 2)}\n`,
    "utf-8",
  );
  return { sessionFile, sessionKey };
}

function buildTranscriptLines(
  sessionId: string,
  messages: Array<{ role: "user" | "assistant" | "system"; text: string }>,
): string {
  const lines = [JSON.stringify({ type: "session", version: 1, id: sessionId })];
  for (const [index, message] of messages.entries()) {
    lines.push(
      JSON.stringify({
        id: `seed-${index + 1}`,
        message: {
          role: message.role,
          content: [{ type: "text", text: message.text }],
          timestamp: Date.now() + index,
        },
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

async function readOpenClawTranscriptSnapshot(params: {
  harness: NativeCliHarness;
  agentId?: string;
  sessionId: string;
}): Promise<OpenClawTranscriptSnapshot | null> {
  const agentId = params.agentId ?? params.harness.agentId;
  const store = await readSessionStore(params.harness.sessionStorePath);
  const match = resolveSessionStoreMatch({
    store,
    agentId,
    sessionId: params.sessionId,
  });
  if (!match) {
    return null;
  }
  const [sessionKey, entry] = match;
  const messages = readSessionMessages(
    params.sessionId,
    params.harness.sessionStorePath,
    entry.sessionFile,
  );
  const assistantTexts = messages
    .map((message) => extractAssistantVisibleText(message))
    .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
  return {
    agentId,
    assistantText: assistantTexts.join("\n").trim(),
    assistantTexts,
    entry,
    ...(typeof entry.sessionFile === "string" ? { localTranscriptPath: entry.sessionFile } : {}),
    messages,
    sessionId: params.sessionId,
    sessionKey,
    toolCalls: collectOpenClawTranscriptToolCalls(messages),
  };
}

export async function waitForOpenClawTranscriptSnapshot(
  harness: NativeCliHarness,
  params: { agentId?: string; sessionId: string },
  predicate: (snapshot: OpenClawTranscriptSnapshot) => boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<OpenClawTranscriptSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: OpenClawTranscriptSnapshot | null = null;

  while (Date.now() < deadline) {
    const snapshot = await readOpenClawTranscriptSnapshot({
      harness,
      agentId: params.agentId,
      sessionId: params.sessionId,
    });
    if (snapshot) {
      lastSnapshot = snapshot;
      if (predicate(snapshot)) {
        return snapshot;
      }
    }
    await sleep(500);
  }

  throw new Error(
    [
      `timed out waiting for OpenClaw transcript snapshot (${params.agentId ?? harness.agentId}:${params.sessionId})`,
      lastSnapshot
        ? [
            `sessionKey: ${lastSnapshot.sessionKey}`,
            `localTranscriptPath: ${lastSnapshot.localTranscriptPath ?? "<none>"}`,
            `assistantText: ${lastSnapshot.assistantText || "<none>"}`,
          ].join("\n")
        : "no transcript snapshot available yet",
      await readGatewayLogTail(harness.gatewayLogPath),
    ].join("\n\n"),
  );
}

export async function runNativeSessionsList(params: {
  harness: NativeCliHarness;
  agentId?: string;
}): Promise<{
  count?: number;
  sessions?: Array<{ key?: string; sessionId?: string; status?: string | null }>;
}> {
  return await runNativeOpenClawJson(
    ["sessions", "--agent", params.agentId ?? params.harness.agentId, "--json"],
    params.harness.cliEnv,
  );
}
