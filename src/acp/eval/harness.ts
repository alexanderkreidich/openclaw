import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AcpxRuntime, createAgentRegistry, createFileSessionStore } from "acpx/runtime";
import { buildClaudeMdContent } from "../../agents/acp-workspace-context.js";
import { createAcpTestConfig } from "../../auto-reply/reply/test-fixtures/acp-runtime.js";
import {
  MCP_SESSION_CONTEXT_FILENAME,
  createOpenClawAgentMcpServer,
  type OpenClawAgentGatewayCaller,
} from "../../mcp/openclaw-agent-serve.js";

export type EvalToolCall = {
  name: string;
  args: unknown;
  result: unknown;
};

export type EvalTranscript = {
  toolCalls: EvalToolCall[];
  replyText: string;
  filesRead: string[];
  filesWritten: string[];
};

export type EvalMode = "mock" | "live";

export type ScriptedEvalToolCall = {
  name: string;
  args?: unknown;
  result?: unknown;
};

export type RunEvalParams = {
  prompt: string;
  sessionSeed: string;
  mode: EvalMode;
  scriptedToolCalls?: ScriptedEvalToolCall[];
  finalReplyText?: string;
};

type GatewayRecord = {
  method: string;
  params: unknown;
  result: unknown;
};

type GatewayMockConfig = {
  callsPath?: string;
  responseByMethod?: Record<string, unknown>;
};

type PersistedSessionRecord = {
  messages?: Array<
    | "Resume"
    | {
        User?: { content?: unknown[] };
      }
    | {
        Agent?: {
          content?: Array<
            | { Text?: string }
            | { Thinking?: { text?: string } }
            | {
                ToolUse?: {
                  id?: string;
                  name?: string;
                  input?: unknown;
                  raw_input?: string;
                };
              }
          >;
          tool_results?: Record<
            string,
            {
              output?: unknown;
              content?: { Text?: string };
            }
          >;
        };
      }
  >;
};

export const EVAL_BOOTSTRAP_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "HEARTBEAT.md",
  "MEMORY.md",
] as const;

const FIXTURE_ROOT = new URL("./fixtures/workspace/", import.meta.url);
const DEFAULT_LIVE_AGENT_ID = process.env.OPENCLAW_ACP_EVAL_AGENT?.trim() || "claude";
const DEFAULT_LIVE_AGENT_COMMAND =
  process.env.OPENCLAW_ACP_EVAL_LIVE_COMMAND?.trim() ||
  "claude-code-acp --mcp-server=openclaw-agent-serve";
const EVAL_GATEWAY_MOCK_ENV = "OPENCLAW_ACP_EVAL_GATEWAY_MOCK_PATH";
const EVAL_KEEP_TMP_ENV = "OPENCLAW_ACP_EVAL_KEEP_TMP";

export function createRecordingGatewayCaller(
  config: GatewayMockConfig = {},
  records: GatewayRecord[] = [],
): OpenClawAgentGatewayCaller {
  return async <T = Record<string, unknown>>(
    input: Parameters<OpenClawAgentGatewayCaller>[0],
  ): Promise<T> => {
    const nextResult = buildGatewayResponse({
      method: input.method,
      params: input.params,
      responseByMethod: config.responseByMethod,
      callCount: records.length,
    });
    const record = {
      method: input.method,
      params: input.params,
      result: nextResult,
    };
    records.push(record);
    if (config.callsPath) {
      await fs.appendFile(config.callsPath, `${JSON.stringify(record)}\n`, "utf-8");
    }
    return structuredClone(nextResult) as T;
  };
}

export async function serveEvalMcpServerFromEnv(): Promise<void> {
  const config = createAcpTestConfig();
  const gatewayConfig = await readGatewayMockConfigFromEnv();
  const gatewayCaller = createRecordingGatewayCaller(gatewayConfig);
  const server = createOpenClawAgentMcpServer({
    config,
    gatewayCaller,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function runEval(params: RunEvalParams): Promise<EvalTranscript> {
  const workspace = await prepareEvalWorkspace(params.sessionSeed);
  try {
    return params.mode === "mock"
      ? await runMockEval({
          ...params,
          workspaceDir: workspace.workspaceDir,
          sessionKey: workspace.sessionKey,
        })
      : await runLiveEval({
          ...params,
          workspaceDir: workspace.workspaceDir,
          sessionKey: workspace.sessionKey,
          gatewayCallsPath: workspace.gatewayCallsPath,
        });
  } finally {
    if (process.env[EVAL_KEEP_TMP_ENV] !== "1") {
      await fs.rm(workspace.rootDir, { recursive: true, force: true });
    }
  }
}

async function runMockEval(
  params: RunEvalParams & {
    workspaceDir: string;
    sessionKey: string;
  },
): Promise<EvalTranscript> {
  const gatewayCaller = createRecordingGatewayCaller();
  const client = await connectInMemoryMcpClient({
    gatewayCaller,
    sessionKey: params.sessionKey,
  });

  const transcriptToolCalls: EvalToolCall[] = [];
  const filesRead: string[] = [];
  const filesWritten: string[] = [];
  const scriptedToolCalls =
    params.scriptedToolCalls ?? buildDefaultScriptedToolCalls(params.prompt);

  try {
    for (const call of scriptedToolCalls) {
      if (isWorkspaceReadTool(call.name)) {
        const filePath = requireToolPath(call.args);
        const absolutePath = path.resolve(params.workspaceDir, filePath);
        const result = call.result ?? (await fs.readFile(absolutePath, "utf-8"));
        transcriptToolCalls.push({
          name: call.name,
          args: normalizeWorkspaceArgs(call.args, params.workspaceDir),
          result,
        });
        pushUnique(filesRead, normalizeWorkspacePath(absolutePath, params.workspaceDir));
        continue;
      }

      if (isWorkspaceWriteTool(call.name)) {
        const filePath = requireToolPath(call.args);
        const absolutePath = path.resolve(params.workspaceDir, filePath);
        const nextContent = resolveWriteContent(call.args, call.result);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, nextContent, "utf-8");
        transcriptToolCalls.push({
          name: call.name,
          args: normalizeWorkspaceArgs(call.args, params.workspaceDir),
          result: call.result ?? { ok: true },
        });
        pushUnique(filesWritten, normalizeWorkspacePath(absolutePath, params.workspaceDir));
        continue;
      }

      if (call.name.startsWith("openclaw_")) {
        const result = await client.callTool({
          name: call.name,
          arguments: (call.args ?? {}) as Record<string, unknown>,
        });
        transcriptToolCalls.push({
          name: call.name,
          args: call.args ?? {},
          result: normalizeMcpToolResult(result as { content?: unknown; isError?: boolean }),
        });
        continue;
      }

      transcriptToolCalls.push({
        name: call.name,
        args: call.args ?? {},
        result: call.result ?? null,
      });
    }
  } finally {
    await client.close();
  }

  return {
    toolCalls: transcriptToolCalls,
    replyText: params.finalReplyText ?? `Mock eval complete for "${params.prompt}"`,
    filesRead,
    filesWritten,
  };
}

async function runLiveEval(
  params: RunEvalParams & {
    workspaceDir: string;
    sessionKey: string;
    gatewayCallsPath: string;
  },
): Promise<EvalTranscript> {
  assertLiveEvalEnabled();

  const runtime = new AcpxRuntime({
    cwd: params.workspaceDir,
    sessionStore: createFileSessionStore({
      stateDir: path.join(path.dirname(params.workspaceDir), "state"),
    }),
    agentRegistry: createAgentRegistry({
      overrides: {
        [DEFAULT_LIVE_AGENT_ID]: DEFAULT_LIVE_AGENT_COMMAND,
      },
    }),
    mcpServers: [
      {
        name: "openclaw-agent-serve",
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          fileUrlToPathString(new URL("../../../scripts/run-acp-evals.mjs", import.meta.url)),
          "serve-mcp",
        ],
        env: [
          { name: EVAL_GATEWAY_MOCK_ENV, value: params.gatewayCallsPath },
          { name: "OPENCLAW_SESSION_KEY", value: params.sessionKey },
          { name: "OPENCLAW_AGENT_ID", value: DEFAULT_LIVE_AGENT_ID },
          { name: "OPENCLAW_ACCOUNT_ID", value: "eval" },
        ],
      },
    ],
    permissionMode: "approve-all",
  });

  const handle = await runtime.ensureSession({
    sessionKey: params.sessionKey,
    agent: DEFAULT_LIVE_AGENT_ID,
    mode: "persistent",
    cwd: params.workspaceDir,
  });

  let replyText = "";
  try {
    for await (const event of runtime.runTurn({
      handle,
      text: params.prompt,
      mode: "prompt",
      requestId: `eval-${randomUUID()}`,
    })) {
      if (event.type === "text_delta" && event.stream !== "thought") {
        replyText += event.text;
      }
    }
  } finally {
    await runtime.close({
      handle,
      reason: "eval-complete",
      discardPersistentState: true,
    });
  }

  const record = await loadPersistedSessionRecord(runtime, handle);
  const toolCalls = extractToolCallsFromRecord(record);
  const { filesRead, filesWritten } = extractFileAccess(toolCalls, params.workspaceDir);

  return {
    toolCalls,
    replyText: replyText.trim(),
    filesRead,
    filesWritten,
  };
}

async function prepareEvalWorkspace(sessionSeed: string): Promise<{
  rootDir: string;
  workspaceDir: string;
  sessionKey: string;
  gatewayCallsPath: string;
}> {
  const sanitizedSeed = sanitizeSeed(sessionSeed);
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-acp-eval-${sanitizedSeed}-`));
  const workspaceDir = path.join(rootDir, "workspace");
  const sessionKey = `agent:${DEFAULT_LIVE_AGENT_ID}:acp:${sanitizedSeed}`;
  const gatewayCallsPath = path.join(rootDir, "gateway-mock.json");

  await fs.cp(FIXTURE_ROOT, workspaceDir, { recursive: true });
  await writeEvalWorkspaceClaudeMd(workspaceDir);
  await writeEvalSessionContext(workspaceDir, {
    sessionKey,
    agentId: DEFAULT_LIVE_AGENT_ID,
    accountId: "eval",
  });
  await fs.writeFile(
    gatewayCallsPath,
    JSON.stringify({ callsPath: path.join(rootDir, "gateway-calls.jsonl") }, null, 2),
    "utf-8",
  );

  return {
    rootDir,
    workspaceDir,
    sessionKey,
    gatewayCallsPath,
  };
}

async function connectInMemoryMcpClient(params: {
  gatewayCaller: OpenClawAgentGatewayCaller;
  sessionKey: string;
}): Promise<{
  callTool: Client["callTool"];
  close: () => Promise<void>;
}> {
  const server = createOpenClawAgentMcpServer({
    config: createAcpTestConfig(),
    gatewayCaller: params.gatewayCaller,
    sessionContext: {
      sessionKey: params.sessionKey,
      agentId: DEFAULT_LIVE_AGENT_ID,
      accountId: "eval",
      gatewayUrl: undefined,
      gatewayToken: undefined,
    },
  });
  const client = new Client({ name: "openclaw-eval-mock", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    callTool: client.callTool.bind(client),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function buildDefaultScriptedToolCalls(prompt: string): ScriptedEvalToolCall[] {
  return [
    ...EVAL_BOOTSTRAP_FILES.map((filePath) => ({
      name: "Read",
      args: { file_path: filePath },
    })),
    {
      name: "openclaw_send",
      args: {
        channel: "eval",
        to: "transcript",
        message: prompt,
      },
    },
  ];
}

async function writeEvalWorkspaceClaudeMd(workspaceDir: string): Promise<void> {
  await fs.writeFile(
    path.join(workspaceDir, "CLAUDE.md"),
    buildClaudeMdContent({
      agentId: DEFAULT_LIVE_AGENT_ID,
      heartbeatEnabled: true,
    }),
    "utf-8",
  );
}

async function writeEvalSessionContext(
  workspaceDir: string,
  params: {
    sessionKey: string;
    agentId: string;
    accountId: string;
  },
): Promise<void> {
  const contextDir = path.join(workspaceDir, path.dirname(MCP_SESSION_CONTEXT_FILENAME));
  await fs.mkdir(contextDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, MCP_SESSION_CONTEXT_FILENAME),
    JSON.stringify(params, null, 2),
    "utf-8",
  );
}

function normalizeMcpToolResult(result: { content?: unknown; isError?: boolean }): unknown {
  if (!Array.isArray(result.content)) {
    return result;
  }
  const text = result.content
    .map((entry) =>
      typeof entry === "object" && entry && "text" in entry ? String(entry.text ?? "") : "",
    )
    .join("")
    .trim();
  if (!text) {
    return result;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readGatewayMockConfigFromEnv(): Promise<GatewayMockConfig> {
  const configPath = process.env[EVAL_GATEWAY_MOCK_ENV];
  if (!configPath) {
    return {};
  }
  const parsed = JSON.parse(await fs.readFile(configPath, "utf-8")) as GatewayMockConfig;
  return parsed;
}

function buildGatewayResponse(params: {
  method: string;
  params: unknown;
  responseByMethod?: Record<string, unknown>;
  callCount: number;
}): unknown {
  if (params.responseByMethod && Object.hasOwn(params.responseByMethod, params.method)) {
    return params.responseByMethod[params.method];
  }
  if (params.method === "send") {
    return {
      ok: true,
      messageId: `eval-msg-${params.callCount + 1}`,
    };
  }
  return {
    ok: true,
    method: params.method,
    params: params.params ?? null,
  };
}

async function loadPersistedSessionRecord(
  runtime: AcpxRuntime,
  handle: { acpxRecordId?: string; sessionKey: string },
): Promise<PersistedSessionRecord | null> {
  const runtimeStore = (
    runtime as unknown as {
      options?: {
        sessionStore?: { load: (sessionId: string) => Promise<PersistedSessionRecord | undefined> };
      };
    }
  ).options?.sessionStore;
  if (!runtimeStore?.load) {
    return null;
  }
  return (
    (handle.acpxRecordId ? await runtimeStore.load(handle.acpxRecordId) : undefined) ??
    (await runtimeStore.load(handle.sessionKey)) ??
    null
  );
}

function extractToolCallsFromRecord(record: PersistedSessionRecord | null): EvalToolCall[] {
  if (!record?.messages) {
    return [];
  }
  const toolCalls: EvalToolCall[] = [];
  for (const message of record.messages) {
    if (!message || typeof message !== "object" || !("Agent" in message) || !message.Agent) {
      continue;
    }
    const toolResults = message.Agent.tool_results ?? {};
    for (const content of message.Agent.content ?? []) {
      if (!content || typeof content !== "object" || !("ToolUse" in content) || !content.ToolUse) {
        continue;
      }
      const toolUse = content.ToolUse;
      const toolResult = toolUse.id ? toolResults[toolUse.id] : undefined;
      toolCalls.push({
        name: typeof toolUse.name === "string" ? toolUse.name : "tool",
        args: parseToolArgs(toolUse.input, toolUse.raw_input),
        result: toolResult?.output ?? toolResult?.content?.Text ?? null,
      });
    }
  }
  return toolCalls;
}

function extractFileAccess(
  toolCalls: EvalToolCall[],
  workspaceDir: string,
): Pick<EvalTranscript, "filesRead" | "filesWritten"> {
  const filesRead: string[] = [];
  const filesWritten: string[] = [];
  for (const toolCall of toolCalls) {
    const targetPaths = extractPathCandidates(toolCall.args).map((entry) =>
      normalizeWorkspacePath(entry, workspaceDir),
    );
    if (isWorkspaceReadTool(toolCall.name)) {
      for (const targetPath of targetPaths) {
        pushUnique(filesRead, targetPath);
      }
    }
    if (isWorkspaceWriteTool(toolCall.name)) {
      for (const targetPath of targetPaths) {
        pushUnique(filesWritten, targetPath);
      }
    }
  }
  return { filesRead, filesWritten };
}

function parseToolArgs(input: unknown, rawInput: string | undefined): unknown {
  if (input && typeof input === "object") {
    return input;
  }
  if (typeof rawInput !== "string" || !rawInput.trim()) {
    return {};
  }
  try {
    return JSON.parse(rawInput);
  } catch {
    return { rawInput };
  }
}

function extractPathCandidates(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const candidates: string[] = [];
  visitValue(value, (key, candidate) => {
    if (typeof candidate === "string" && isPathLikeKey(key)) {
      candidates.push(candidate);
    }
    if (Array.isArray(candidate) && isPathLikeKey(key)) {
      for (const entry of candidate) {
        if (typeof entry === "string") {
          candidates.push(entry);
        }
      }
    }
  });
  return candidates;
}

function visitValue(value: unknown, visitor: (key: string, candidate: unknown) => void): void {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, candidate] of Object.entries(value)) {
    visitor(key, candidate);
    visitValue(candidate, visitor);
  }
}

function isPathLikeKey(key: string): boolean {
  return [
    "path",
    "paths",
    "file",
    "file_path",
    "filePath",
    "filepath",
    "target_file",
    "targetPath",
    "destination",
  ].includes(key);
}

function requireToolPath(args: unknown): string {
  const [firstPath] = extractPathCandidates(args);
  if (!firstPath) {
    throw new Error("Scripted file tool requires a path-like argument.");
  }
  return firstPath;
}

function resolveWriteContent(args: unknown, fallbackResult: unknown): string {
  if (args && typeof args === "object") {
    for (const key of ["content", "text", "contents"]) {
      const value = (args as Record<string, unknown>)[key];
      if (typeof value === "string") {
        return value;
      }
    }
  }
  return typeof fallbackResult === "string" ? fallbackResult : "";
}

function normalizeWorkspaceArgs(args: unknown, workspaceDir: string): unknown {
  if (!args || typeof args !== "object") {
    return args ?? {};
  }
  const next = structuredClone(args) as Record<string, unknown>;
  visitValue(next, (key, candidate) => {
    if (!isPathLikeKey(key) || typeof candidate !== "string") {
      return;
    }
    next[key] = normalizeWorkspacePath(candidate, workspaceDir);
  });
  return next;
}

function normalizeWorkspacePath(targetPath: string, workspaceDir: string): string {
  if (!targetPath) {
    return targetPath;
  }
  const resolved = path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.resolve(workspaceDir, targetPath);
  const relative = path.relative(workspaceDir, resolved);
  if (relative && !relative.startsWith("..")) {
    return relative.replaceAll(path.sep, "/");
  }
  return targetPath.replaceAll(path.sep, "/");
}

function isWorkspaceReadTool(name: string): boolean {
  return /^(read|view|cat)$/iu.test(name.trim());
}

function isWorkspaceWriteTool(name: string): boolean {
  return /^(write|edit|update)$/iu.test(name.trim());
}

function pushUnique(values: string[], next: string): void {
  if (next && !values.includes(next)) {
    values.push(next);
  }
}

function assertLiveEvalEnabled(): void {
  if (process.env.LIVE === "1") {
    return;
  }
  throw new Error("Live ACP evals are gated. Re-run with `LIVE=1`.");
}

function sanitizeSeed(seed: string): string {
  const normalized = seed
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-");
  return normalized || randomUUID();
}

function fileUrlToPathString(fileUrl: URL): string {
  return fileURLToPath(fileUrl);
}
