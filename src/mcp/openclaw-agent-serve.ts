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
import {
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "../agents/pi-tools.before-tool-call.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGatewayCli } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import { routeLogsToStderr } from "../logging/console.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { VERSION } from "../version.js";

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

async function gw<T = Record<string, unknown>>(
  ctx: SessionContext,
  method: string,
  params?: unknown,
): Promise<T> {
  return await callGatewayCli<T>({
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
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
};

function defineBuiltinTools(): ToolDef[] {
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
        const result = await gw(ctx, "send", { ...args, idempotencyKey: crypto.randomUUID() });
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
        if (!ctx.sessionKey) {
          return errorContent("No session key — cannot determine conversation context");
        }
        const result = await gw(ctx, "agent", {
          sessionKey: ctx.sessionKey,
          message: args.message,
          deliver: true,
          idempotencyKey: crypto.randomUUID(),
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
        const result = await gw(ctx, "chat.history", {
          sessionKey: args.session_key,
          limit: args.limit ?? 20,
        });
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
        const result = await gw(ctx, "sessions.list", {
          limit: args.limit ?? 50,
          search: args.search,
          channel: args.channel,
          includeDerivedTitles: true,
          includeLastMessage: true,
        });
        return jsonContent(result);
      },
    },
    // -- Session management --
    {
      name: "openclaw_session_status",
      description: "Get current gateway and session status.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) => jsonContent(await gw(ctx, "status")),
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
        if (args.message) {
          await gw(ctx, "agent", {
            sessionKey: ctx.sessionKey,
            message: args.message,
            deliver: true,
            idempotencyKey: crypto.randomUUID(),
          });
        }
        await gw(ctx, "sessions.delete", { key: ctx.sessionKey, deleteTranscript: false });
        return textContent("Session closed successfully.");
      },
    },
    {
      name: "openclaw_spawn_agent",
      description: "Spawn a new agent session to delegate a task.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent ID or alias" },
          task: { type: "string", description: "Task description" },
          thread: { type: "boolean", description: "Bind to a thread" },
        },
        required: ["agentId", "task"],
      },
      handler: async (args, ctx) => {
        const result = await gw(ctx, "agent", {
          agentId: args.agentId,
          task: args.task,
          thread: args.thread ?? false,
          idempotencyKey: crypto.randomUUID(),
        });
        return jsonContent(result);
      },
    },
    // -- Scheduling --
    {
      name: "openclaw_cron_list",
      description: "List scheduled recurring tasks.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) => jsonContent(await gw(ctx, "cron.list")),
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
      handler: async (args, ctx) => jsonContent(await gw(ctx, "cron.add", args)),
    },
    {
      name: "openclaw_cron_remove",
      description: "Remove a scheduled recurring task.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      handler: async (args, ctx) => jsonContent(await gw(ctx, "cron.remove", args)),
    },
    {
      name: "openclaw_cron_run",
      description: "Manually trigger a scheduled task now.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      handler: async (args, ctx) => jsonContent(await gw(ctx, "cron.run", args)),
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
        const result = await gw(ctx, "agent", {
          sessionKey: ctx.sessionKey,
          tool: "image_generate",
          toolInput: args,
          idempotencyKey: crypto.randomUUID(),
        });
        return jsonContent(result);
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
      handler: async (args, ctx) => jsonContent(await gw(ctx, "tts.convert", args)),
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
        const result = await gw(ctx, "agent", {
          sessionKey: ctx.sessionKey,
          tool: "web_search",
          toolInput: args,
          idempotencyKey: crypto.randomUUID(),
        });
        return jsonContent(result);
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
        const result = await gw(ctx, "agent", {
          sessionKey: ctx.sessionKey,
          tool: "web_fetch",
          toolInput: args,
          idempotencyKey: crypto.randomUUID(),
        });
        return jsonContent(result);
      },
    },
    // -- Nodes --
    {
      name: "openclaw_node_list",
      description: "List connected nodes and devices.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) => jsonContent(await gw(ctx, "node.list")),
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
        const result = await gw(ctx, "node.invoke", {
          ...args,
          idempotencyKey: crypto.randomUUID(),
        });
        return jsonContent(result);
      },
    },
    // -- Agents --
    {
      name: "openclaw_agents_list",
      description: "List available agents and their configurations.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) => jsonContent(await gw(ctx, "agents.list")),
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
      handler: async (args, ctx) => jsonContent(await gw(ctx, "config.get", args)),
    },
    {
      name: "openclaw_channels_status",
      description: "Check connectivity status of all configured channels.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) => jsonContent(await gw(ctx, "channels.status")),
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
        return jsonContent(await gw(ctx, method));
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
        return jsonContent(await gw(ctx, method, { id: args.id, decision: args.decision }));
      },
    },
    // -- Models --
    {
      name: "openclaw_models_list",
      description: "List available AI models across all configured providers.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) => jsonContent(await gw(ctx, "models.list")),
    },
  ];
}

// ---------------------------------------------------------------------------
// Server creation
// ---------------------------------------------------------------------------

export function createOpenClawAgentMcpServer(
  params: {
    config?: OpenClawConfig;
    pluginTools?: AnyAgentTool[];
    sessionContext?: SessionContext;
  } = {},
): Server {
  const cfg = params.config ?? loadConfig();
  const ctx = params.sessionContext ?? resolveSessionContext();

  const builtinTools = defineBuiltinTools();

  // Resolve plugin tools
  const pluginTools = (
    params.pluginTools ??
    resolvePluginTools({
      context: { config: cfg },
      suppressNameConflicts: true,
    })
  ).map((tool) => {
    if (isToolWrappedWithBeforeToolCallHook(tool)) {
      return tool;
    }
    return wrapToolWithBeforeToolCallHook(tool);
  });

  // Build combined tool map
  const builtinMap = new Map<string, ToolDef>();
  for (const tool of builtinTools) {
    builtinMap.set(tool.name, tool);
  }
  const pluginMap = new Map<string, AnyAgentTool>();
  for (const tool of pluginTools) {
    pluginMap.set(tool.name, tool);
  }

  const server = new Server(
    { name: "openclaw", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
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
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    const name = request.params.name;

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
    const plugin = pluginMap.get(name);
    if (plugin) {
      try {
        const result = await plugin.execute(`mcp-${Date.now()}`, args);
        return Array.isArray(result.content)
          ? { content: result.content }
          : textContent(String(result.content));
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

// In bundled dist, tsdown may code-split this module into a separate chunk
// whose import.meta.url differs from process.argv[1]. Match on filename
// instead of strict URL equality so the entry point works in both source
// and bundled layouts.
const entryArg = process.argv[1] ?? "";
if (
  import.meta.url === pathToFileURL(entryArg).href ||
  entryArg.endsWith("/mcp/openclaw-agent-serve.js") ||
  entryArg.endsWith("/mcp/openclaw-agent-serve.ts")
) {
  serveOpenClawAgentMcp().catch((err) => {
    process.stderr.write(`openclaw-agent-serve: ${formatErrorMessage(err)}\n`);
    process.exit(1);
  });
}
