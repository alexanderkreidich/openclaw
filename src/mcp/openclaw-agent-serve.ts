/**
 * Unified MCP server that exposes the full OpenClaw tool surface to Claude Code
 * ACP sessions. Combines gateway operations, plugin tools, and session control
 * into a single stdio MCP server.
 *
 * Run via: node --import tsx src/mcp/openclaw-agent-serve.ts
 * Or: bun src/mcp/openclaw-agent-serve.ts
 *
 * Session context resolution (first match wins):
 *   1. Environment variables:
 *        OPENCLAW_SESSION_KEY, OPENCLAW_AGENT_ID, OPENCLAW_ACCOUNT_ID,
 *        OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN
 *   2. Workspace context file (written by gateway before ACP session creation):
 *        <cwd>/.openclaw/mcp-session-context.json
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agents/pi-tools.before-tool-call.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createImageGenerateTool } from "../agents/tools/image-generate-tool.js";
import { createSessionsSpawnTool } from "../agents/tools/sessions-spawn-tool.js";
import { createWebFetchTool, createWebSearchTool } from "../agents/tools/web-tools.js";
import { loadConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore, resolveSessionStoreEntry } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGatewayCli } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import { routeLogsToStderr } from "../logging/console.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { deliveryContextFromSession } from "../utils/delivery-context.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
  type GatewayMessageChannel,
} from "../utils/message-channel.js";
import { VERSION } from "../version.js";

const HIDDEN_NATIVE_CLI_PLUGIN_TOOL_NAMES = new Set([
  "sessions_spawn",
  "image_generate",
  "web_search",
  "web_fetch",
]);

function shouldHideNativeCliToolName(name: string): boolean {
  return HIDDEN_NATIVE_CLI_PLUGIN_TOOL_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// Session context from environment
// ---------------------------------------------------------------------------

export type SessionContext = {
  sessionKey: string | undefined;
  agentId: string | undefined;
  accountId: string | undefined;
  gatewayUrl: string | undefined;
  gatewayToken: string | undefined;
};

/** Well-known workspace file written by the gateway before ACP session creation. */
export const MCP_SESSION_CONTEXT_FILENAME = ".openclaw/mcp-session-context.json";

function readWorkspaceSessionContext(cwd: string = process.cwd()): SessionContext | undefined {
  try {
    const filePath = path.join(cwd, MCP_SESSION_CONTEXT_FILENAME);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    const str = (key: string) => (typeof raw[key] === "string" ? raw[key] : undefined);
    return {
      sessionKey: str("sessionKey"),
      agentId: str("agentId"),
      accountId: str("accountId"),
      gatewayUrl: str("gatewayUrl"),
      gatewayToken: str("gatewayToken"),
    };
  } catch {
    return undefined;
  }
}

export function resolveSessionContext(
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): SessionContext {
  const fromEnv: SessionContext = {
    sessionKey: env.OPENCLAW_SESSION_KEY,
    agentId: env.OPENCLAW_AGENT_ID,
    accountId: env.OPENCLAW_ACCOUNT_ID,
    gatewayUrl: env.OPENCLAW_GATEWAY_URL,
    gatewayToken: env.OPENCLAW_GATEWAY_TOKEN,
  };
  // If env has a session key, use env vars (primary path)
  if (fromEnv.sessionKey) {
    return fromEnv;
  }
  // Fallback: read from workspace context file (ACPX path — cwd is per-session)
  const fromFile = readWorkspaceSessionContext(cwd);
  if (fromFile?.sessionKey) {
    return fromFile;
  }
  return fromEnv;
}

// ---------------------------------------------------------------------------
// Gateway call helper
// ---------------------------------------------------------------------------

export type OpenClawAgentGatewayCaller = typeof callGatewayCli;

async function gw<T = Record<string, unknown>>(
  ctx: SessionContext,
  method: string,
  params?: unknown,
  gatewayCaller: OpenClawAgentGatewayCaller = callGatewayCli,
): Promise<T> {
  return await gatewayCaller<T>({
    method,
    params,
    ...(ctx.gatewayUrl ? { url: ctx.gatewayUrl } : {}),
    ...(ctx.gatewayToken ? { token: ctx.gatewayToken } : {}),
  });
}

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonContent(data: unknown) {
  return textContent(JSON.stringify(data, null, 2));
}

function errorContent(err: unknown) {
  const text = typeof err === "string" ? err : `Error: ${formatErrorMessage(err)}`;
  return { content: [{ type: "text" as const, text }], isError: true };
}

type SessionDeliveryTarget = {
  deliveryContext: ReturnType<typeof deliveryContextFromSession>;
  channel?: GatewayMessageChannel;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

type MpcRuntimeContext = {
  sessionEntry?: SessionEntry;
  deliveryTarget: SessionDeliveryTarget;
  agentDir?: string;
  workspaceDir: string;
  sessionId?: string;
  agentChannel?: GatewayMessageChannel;
  agentTo?: string;
  agentThreadId?: string | number;
  agentAccountId?: string;
  agentGroupId?: string;
  agentGroupChannel?: string;
  agentGroupSpace?: string;
};

function readSessionEntry(_cfg: OpenClawConfig, sessionKey?: string): SessionEntry | undefined {
  if (!sessionKey) {
    return undefined;
  }
  try {
    const store = loadSessionStore(resolveStorePath());
    return resolveSessionStoreEntry({ store, sessionKey }).existing;
  } catch {
    return undefined;
  }
}

function resolveSessionDeliveryTarget(entry?: SessionEntry): SessionDeliveryTarget {
  const deliveryContext = deliveryContextFromSession(entry);
  const rawChannel = deliveryContext?.channel;
  const normalizedChannel = rawChannel
    ? (normalizeMessageChannel(rawChannel) ?? rawChannel)
    : undefined;
  const channel =
    normalizedChannel && isDeliverableMessageChannel(normalizedChannel)
      ? normalizedChannel
      : undefined;
  const to = typeof deliveryContext?.to === "string" ? deliveryContext.to.trim() : undefined;
  return {
    deliveryContext,
    channel,
    to: to || undefined,
    accountId: deliveryContext?.accountId,
    threadId: deliveryContext?.threadId,
  };
}

function resolveMcpRuntimeContext(cfg: OpenClawConfig, ctx: SessionContext): MpcRuntimeContext {
  const sessionEntry = readSessionEntry(cfg, ctx.sessionKey);
  const deliveryTarget = resolveSessionDeliveryTarget(sessionEntry);
  const agentId = ctx.agentId?.trim() || undefined;
  const agentDir = agentId ? resolveAgentDir(cfg, agentId) : undefined;
  const normalizedChannel = deliveryTarget.deliveryContext?.channel
    ? normalizeMessageChannel(deliveryTarget.deliveryContext.channel)
    : undefined;
  return {
    sessionEntry,
    deliveryTarget,
    agentDir,
    workspaceDir: process.cwd(),
    sessionId: sessionEntry?.sessionId,
    agentChannel: normalizedChannel as GatewayMessageChannel | undefined,
    agentTo: deliveryTarget.deliveryContext?.to,
    agentThreadId: deliveryTarget.deliveryContext?.threadId,
    agentAccountId: deliveryTarget.deliveryContext?.accountId ?? ctx.accountId,
    agentGroupId: sessionEntry?.groupId,
    agentGroupChannel: sessionEntry?.groupChannel,
    agentGroupSpace: sessionEntry?.space,
  };
}

function resolveMcpInternalAgentTools(params: {
  config: OpenClawConfig;
  sessionContext: SessionContext;
  agentTools?: AnyAgentTool[];
}): AnyAgentTool[] {
  if (params.agentTools) {
    return params.agentTools;
  }
  const runtime = resolveMcpRuntimeContext(params.config, params.sessionContext);
  return collectPresentTools([
    createSessionsSpawnTool({
      agentSessionKey: params.sessionContext.sessionKey,
      agentChannel: runtime.agentChannel,
      agentAccountId: runtime.agentAccountId,
      agentTo: runtime.agentTo,
      agentThreadId: runtime.agentThreadId,
      agentGroupId: runtime.agentGroupId,
      agentGroupChannel: runtime.agentGroupChannel,
      agentGroupSpace: runtime.agentGroupSpace,
      workspaceDir: runtime.workspaceDir,
    }),
    createImageGenerateTool({
      config: params.config,
      agentDir: runtime.agentDir,
      workspaceDir: runtime.workspaceDir,
    }),
    createWebSearchTool({
      config: params.config,
    }),
    createWebFetchTool({
      config: params.config,
    }),
  ]);
}

function resolveMcpPluginTools(params: {
  config: OpenClawConfig;
  sessionContext: SessionContext;
  pluginTools?: AnyAgentTool[];
  existingToolNames?: Set<string>;
}): AnyAgentTool[] {
  const runtime = resolveMcpRuntimeContext(params.config, params.sessionContext);
  const pluginTools =
    params.pluginTools ??
    resolvePluginTools({
      context: {
        config: params.config,
        runtimeConfig: params.config,
        workspaceDir: runtime.workspaceDir,
        agentDir: runtime.agentDir,
        agentId: params.sessionContext.agentId,
        sessionKey: params.sessionContext.sessionKey,
        sessionId: runtime.sessionId,
        messageChannel: runtime.agentChannel,
        agentAccountId: runtime.agentAccountId,
        deliveryContext: runtime.deliveryTarget.deliveryContext,
      },
      existingToolNames: params.existingToolNames,
      suppressNameConflicts: true,
    });
  return pluginTools
    .filter((tool) => !shouldHideNativeCliToolName(tool.name))
    .map((tool) => {
      if (isToolWrappedWithBeforeToolCallHook(tool)) {
        return tool;
      }
      return wrapToolWithBeforeToolCallHook(tool);
    });
}

async function executeMcpInternalAgentTool(params: {
  name: string;
  args: Record<string, unknown>;
  config: OpenClawConfig;
  sessionContext: SessionContext;
  agentTools?: AnyAgentTool[];
}) {
  const tool = resolveMcpInternalAgentTools(params).find((entry) => entry.name === params.name);
  if (!tool) {
    throw new Error(`OpenClaw MCP tool runtime missing internal tool: ${params.name}`);
  }
  return await tool.execute(`mcp-${params.name}-${Date.now()}`, params.args);
}

async function sendCurrentSessionReply(params: {
  config: OpenClawConfig;
  sessionContext: SessionContext;
  message: string;
  gatewayCaller?: OpenClawAgentGatewayCaller;
}) {
  if (!params.sessionContext.sessionKey) {
    throw new Error("No session key — cannot determine conversation context");
  }
  const runtime = resolveMcpRuntimeContext(params.config, params.sessionContext);
  const target = runtime.deliveryTarget;
  if (!target.channel || !target.to) {
    throw new Error("Current session has no deliverable reply target");
  }
  return await gw(
    params.sessionContext,
    "send",
    {
      channel: target.channel,
      to: target.to,
      message: params.message,
      accountId: target.accountId ?? params.sessionContext.accountId,
      threadId: target.threadId == null ? undefined : String(target.threadId),
      sessionKey: params.sessionContext.sessionKey,
      agentId: params.sessionContext.agentId,
      idempotencyKey: crypto.randomUUID(),
    },
    params.gatewayCaller,
  );
}

function toToolContent(result: { content?: unknown }) {
  if (Array.isArray(result.content)) {
    return { content: result.content };
  }
  const content = result.content;
  const text =
    typeof content === "string" ? content : content == null ? "" : JSON.stringify(content);
  return textContent(text);
}

function collectPresentTools(tools: Array<AnyAgentTool | null | undefined>): AnyAgentTool[] {
  return tools.filter((tool): tool is AnyAgentTool => Boolean(tool));
}

// ---------------------------------------------------------------------------
// Tool schema helper
// ---------------------------------------------------------------------------

function resolveJsonSchemaForTool(tool: AnyAgentTool): Record<string, unknown> {
  const params = tool.parameters;
  if (params && typeof params === "object" && "type" in params) {
    return params as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
}

// ---------------------------------------------------------------------------
// Built-in tool definitions
// ---------------------------------------------------------------------------

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
    ctx: SessionContext,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
};

function defineBuiltinTools(params: {
  config: OpenClawConfig;
  sessionContext: SessionContext;
  agentTools?: AnyAgentTool[];
  gatewayCaller?: OpenClawAgentGatewayCaller;
}): ToolDef[] {
  return [
    // -- Messaging --
    {
      name: "openclaw_send",
      description: "Send a message through any OpenClaw channel to a specific recipient.",
      inputSchema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Channel: telegram, discord, slack, signal, whatsapp, etc.",
          },
          to: {
            type: "string",
            description: "Recipient: chat ID, username, phone, or channel-specific target",
          },
          message: { type: "string", description: "Message text" },
          accountId: { type: "string", description: "Account ID (if multiple accounts)" },
        },
        required: ["channel", "to", "message"],
      },
      handler: async (args, ctx) => {
        const result = await gw(
          ctx,
          "send",
          { ...args, idempotencyKey: crypto.randomUUID() },
          params.gatewayCaller,
        );
        return jsonContent(result);
      },
    },
    {
      name: "openclaw_reply",
      description: "Reply in the current conversation context.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "Reply text" } },
        required: ["message"],
      },
      handler: async (args, ctx) => {
        const result = await sendCurrentSessionReply({
          config: params.config,
          sessionContext: ctx,
          message: String(args.message),
          gatewayCaller: params.gatewayCaller,
        });
        return jsonContent(result);
      },
    },
    {
      name: "openclaw_read_history",
      description: "Read recent messages from a conversation.",
      inputSchema: {
        type: "object",
        properties: {
          session_key: { type: "string", description: "Session key of the conversation" },
          limit: { type: "number", description: "Number of messages (default 20, max 200)" },
        },
        required: ["session_key"],
      },
      handler: async (args, ctx) => {
        const result = await gw(
          ctx,
          "chat.history",
          {
            sessionKey: args.session_key,
            limit: args.limit ?? 20,
          },
          params.gatewayCaller,
        );
        return jsonContent(result);
      },
    },
    {
      name: "openclaw_conversations_list",
      description: "List active OpenClaw conversations across all channels.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max results (default 50)" },
          search: { type: "string", description: "Search filter" },
          channel: { type: "string", description: "Filter by channel" },
        },
      },
      handler: async (args, ctx) => {
        const result = await gw(
          ctx,
          "sessions.list",
          {
            limit: args.limit ?? 50,
            search: args.search,
            channel: args.channel,
            includeDerivedTitles: true,
            includeLastMessage: true,
          },
          params.gatewayCaller,
        );
        return jsonContent(result);
      },
    },
    // -- Session management --
    {
      name: "openclaw_session_status",
      description: "Get current gateway and session status.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) =>
        jsonContent(await gw(ctx, "status", undefined, params.gatewayCaller)),
    },
    {
      name: "openclaw_session_close",
      description:
        "Close the current ACP session and hand control back. Use when task is complete or off-topic.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "Optional handoff summary" } },
      },
      handler: async (args, ctx) => {
        if (!ctx.sessionKey) {
          return errorContent("No session key — cannot close session");
        }
        const runtime = resolveMcpRuntimeContext(params.config, ctx);
        if (args.message && runtime.deliveryTarget.channel && runtime.deliveryTarget.to) {
          await sendCurrentSessionReply({
            config: params.config,
            sessionContext: ctx,
            message: typeof args.message === "string" ? args.message : "",
            gatewayCaller: params.gatewayCaller,
          });
        }
        await gw(
          ctx,
          "sessions.delete",
          { key: ctx.sessionKey, deleteTranscript: false },
          params.gatewayCaller,
        );
        return textContent("Session closed successfully.");
      },
    },
    {
      name: "openclaw_spawn_agent",
      description:
        'Spawn a new ACP child session to delegate a task. Use this for complex research or coding work, and for explicit requests like "Do this in Claude Code". This is the preferred delegation tool on the OpenClaw MCP surface; omit `agentId` to use the configured ACP default agent, and reserve raw `sessions_spawn` for advanced controls like thread/session binding or resume. For broad research/investigation requests, do this before using direct WebSearch yourself.',
      inputSchema: {
        type: "object",
        properties: {
          agentId: {
            type: "string",
            description: "Agent ID or alias; omit to use the configured ACP default agent",
          },
          task: { type: "string", description: "Task description" },
          thread: { type: "boolean", description: "Bind to a thread" },
        },
        required: ["task"],
      },
      handler: async (args, ctx) => {
        const result = await executeMcpInternalAgentTool({
          name: "sessions_spawn",
          args: {
            task: args.task,
            ...(typeof args.agentId === "string" && args.agentId.trim()
              ? { agentId: args.agentId }
              : {}),
            thread: args.thread ?? false,
            runtime: "acp",
          },
          config: params.config,
          sessionContext: ctx,
          agentTools: params.agentTools,
        });
        return toToolContent(result);
      },
    },
    // -- Scheduling --
    {
      name: "openclaw_cron_list",
      description: "List scheduled recurring tasks.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) =>
        jsonContent(await gw(ctx, "cron.list", undefined, params.gatewayCaller)),
    },
    {
      name: "openclaw_cron_add",
      description: "Schedule a new recurring task.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Cron job name" },
          schedule: { type: "string", description: "Cron expression (e.g., '0 9 * * *')" },
          task: { type: "string", description: "Task to execute" },
          agentId: { type: "string", description: "Agent to run the task" },
        },
        required: ["name", "schedule", "task"],
      },
      handler: async (args, ctx) =>
        jsonContent(await gw(ctx, "cron.add", args, params.gatewayCaller)),
    },
    {
      name: "openclaw_cron_remove",
      description: "Remove a scheduled recurring task.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      handler: async (args, ctx) =>
        jsonContent(await gw(ctx, "cron.remove", args, params.gatewayCaller)),
    },
    {
      name: "openclaw_cron_run",
      description: "Manually trigger a scheduled task now.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      handler: async (args, ctx) =>
        jsonContent(await gw(ctx, "cron.run", args, params.gatewayCaller)),
    },
    // -- Media --
    {
      name: "openclaw_image_generate",
      description: "Generate an image from a text prompt.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Image generation prompt" },
          model: { type: "string", description: "Model (e.g., dall-e-3)" },
          size: { type: "string", description: "Image size (e.g., 1024x1024)" },
        },
        required: ["prompt"],
      },
      handler: async (args, ctx) => {
        const result = await executeMcpInternalAgentTool({
          name: "image_generate",
          args,
          config: params.config,
          sessionContext: ctx,
          agentTools: params.agentTools,
        });
        return toToolContent(result);
      },
    },
    {
      name: "openclaw_tts",
      description: "Convert text to speech audio.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to convert" },
          voice: { type: "string", description: "Voice name or ID" },
        },
        required: ["text"],
      },
      handler: async (args, ctx) =>
        jsonContent(await gw(ctx, "tts.convert", args, params.gatewayCaller)),
    },
    // -- Web --
    {
      name: "openclaw_web_search",
      description: "Search the web for information.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results" },
        },
        required: ["query"],
      },
      handler: async (args, ctx) => {
        const result = await executeMcpInternalAgentTool({
          name: "web_search",
          args,
          config: params.config,
          sessionContext: ctx,
          agentTools: params.agentTools,
        });
        return toToolContent(result);
      },
    },
    {
      name: "openclaw_web_fetch",
      description: "Fetch and parse content from a URL.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
          format: { type: "string", description: "Output format: text, markdown, html" },
        },
        required: ["url"],
      },
      handler: async (args, ctx) => {
        const result = await executeMcpInternalAgentTool({
          name: "web_fetch",
          args,
          config: params.config,
          sessionContext: ctx,
          agentTools: params.agentTools,
        });
        return toToolContent(result);
      },
    },
    // -- Nodes --
    {
      name: "openclaw_node_list",
      description: "List connected nodes and devices.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) =>
        jsonContent(await gw(ctx, "node.list", undefined, params.gatewayCaller)),
    },
    {
      name: "openclaw_node_invoke",
      description: "Run a command on a connected node.",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: { type: "string", description: "Node ID" },
          command: { type: "string", description: "Command to execute" },
          args: { type: "object", description: "Command arguments" },
        },
        required: ["nodeId", "command"],
      },
      handler: async (args, ctx) => {
        const result = await gw(
          ctx,
          "node.invoke",
          {
            ...args,
            idempotencyKey: crypto.randomUUID(),
          },
          params.gatewayCaller,
        );
        return jsonContent(result);
      },
    },
    // -- Agents --
    {
      name: "openclaw_agents_list",
      description:
        "List configured OpenClaw agent ids and their configurations. This is for OpenClaw agent discovery, not ACP harness discovery, and not for polling loops.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) =>
        jsonContent(await gw(ctx, "agents.list", undefined, params.gatewayCaller)),
    },
    // -- Config & status --
    {
      name: "openclaw_config_get",
      description: "Read an OpenClaw configuration value.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string", description: "Config key path" } },
        required: ["key"],
      },
      handler: async (args, ctx) =>
        jsonContent(await gw(ctx, "config.get", args, params.gatewayCaller)),
    },
    {
      name: "openclaw_channels_status",
      description: "Check connectivity status of all configured channels.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) =>
        jsonContent(await gw(ctx, "channels.status", undefined, params.gatewayCaller)),
    },
    // -- Approvals --
    {
      name: "openclaw_approval_list",
      description: "List pending execution or plugin approval requests.",
      inputSchema: {
        type: "object",
        properties: { kind: { type: "string", description: "Filter: exec or plugin" } },
      },
      handler: async (args, ctx) => {
        const method = args.kind === "plugin" ? "plugin.approval.list" : "exec.approval.list";
        return jsonContent(await gw(ctx, method, undefined, params.gatewayCaller));
      },
    },
    {
      name: "openclaw_approval_resolve",
      description: "Allow or deny a pending approval request.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", description: "exec or plugin" },
          id: { type: "string", description: "Approval request ID" },
          decision: { type: "string", description: "allow-once, allow-always, or deny" },
        },
        required: ["kind", "id", "decision"],
      },
      handler: async (args, ctx) => {
        const method = args.kind === "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve";
        return jsonContent(
          await gw(ctx, method, { id: args.id, decision: args.decision }, params.gatewayCaller),
        );
      },
    },
    // -- Models --
    {
      name: "openclaw_models_list",
      description: "List available AI models across all configured providers.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) =>
        jsonContent(await gw(ctx, "models.list", undefined, params.gatewayCaller)),
    },
  ];
}

// ---------------------------------------------------------------------------
// Server creation
// ---------------------------------------------------------------------------

export function createOpenClawAgentMcpServer(
  params: {
    config?: OpenClawConfig;
    agentTools?: AnyAgentTool[];
    pluginTools?: AnyAgentTool[];
    sessionContext?: SessionContext;
    gatewayCaller?: OpenClawAgentGatewayCaller;
  } = {},
): Server {
  const cfg = params.config ?? loadConfig();
  const ctx = params.sessionContext ?? resolveSessionContext();

  const builtinTools = defineBuiltinTools({
    config: cfg,
    sessionContext: ctx,
    agentTools: params.agentTools,
    gatewayCaller: params.gatewayCaller,
  });

  // Build combined tool map
  const builtinMap = new Map<string, ToolDef>();
  for (const tool of builtinTools) {
    builtinMap.set(tool.name, tool);
  }

  const server = new Server(
    { name: "openclaw", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (() => {
      const pluginTools = resolveMcpPluginTools({
        config: cfg,
        sessionContext: ctx,
        pluginTools: params.pluginTools,
        existingToolNames: new Set(builtinTools.map((tool) => tool.name)),
      });
      return [
        ...builtinTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
        ...pluginTools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: resolveJsonSchemaForTool(t),
        })),
      ].filter((tool) => !shouldHideNativeCliToolName(tool.name));
    })(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    const name = request.params.name;

    if (shouldHideNativeCliToolName(name)) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    // Check built-in tools first
    const builtin = builtinMap.get(name);
    if (builtin) {
      try {
        return await builtin.handler(args, ctx);
      } catch (err) {
        return errorContent(err);
      }
    }

    // Check plugin tools
    const pluginMap = new Map<string, AnyAgentTool>();
    for (const tool of resolveMcpPluginTools({
      config: cfg,
      sessionContext: ctx,
      pluginTools: params.pluginTools,
      existingToolNames: new Set(builtinTools.map((tool) => tool.name)),
    })) {
      pluginMap.set(tool.name, tool);
    }
    const plugin = pluginMap.get(name);
    if (plugin) {
      try {
        const result = await plugin.execute(`mcp-${Date.now()}`, args);
        return toToolContent(result);
      } catch (err) {
        return errorContent(err);
      }
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return server;
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

export async function serveOpenClawAgentMcp(): Promise<void> {
  routeLogsToStderr();

  const config = loadConfig();
  const ctx = resolveSessionContext();
  const server = createOpenClawAgentMcpServer({ config, sessionContext: ctx });

  process.stderr.write(
    `openclaw-agent-serve: started (session=${ctx.sessionKey ?? "none"}, agent=${ctx.agentId ?? "none"})\n`,
  );

  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdin.off("end", shutdown);
    process.stdin.off("close", shutdown);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    void server.close();
  };

  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await server.connect(transport);
}

export function isOpenClawAgentServeEntrypoint(importMetaUrl: string, entryArg?: string): boolean {
  const resolvedEntryArg = entryArg ?? "";
  const normalizedEntryArg = resolvedEntryArg.replaceAll("\\", "/");
  return (
    importMetaUrl === pathToFileURL(resolvedEntryArg).href ||
    normalizedEntryArg.endsWith("/mcp/openclaw-agent-serve.js") ||
    normalizedEntryArg.endsWith("/mcp/openclaw-agent-serve.ts")
  );
}

// In bundled dist, tsdown may code-split this module into a separate chunk
// whose import.meta.url differs from process.argv[1]. Match on filename
// instead of strict URL equality so the entry point works in both source
// and bundled layouts.
if (isOpenClawAgentServeEntrypoint(import.meta.url, process.argv[1])) {
  serveOpenClawAgentMcp().catch((err) => {
    process.stderr.write(`openclaw-agent-serve: ${formatErrorMessage(err)}\n`);
    process.exit(1);
  });
}
