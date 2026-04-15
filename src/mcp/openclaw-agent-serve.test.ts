import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  createOpenClawAgentMcpServer,
  isOpenClawAgentServeEntrypoint,
  resolveSessionContext,
} from "./openclaw-agent-serve.js";

// Mock callGatewayCli
const callGatewayCliMock = vi.fn();
const callGatewayMock = vi.fn();
const loadSessionStoreMock = vi.fn();
const resolveSessionStoreEntryMock = vi.fn();
const resolveStorePathMock = vi.fn();
const resolvePluginToolsMock = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGatewayCli: (...args: unknown[]) => callGatewayCliMock(...args),
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));
vi.mock("../config/sessions/paths.js", () => ({
  resolveStorePath: (...args: unknown[]) => resolveStorePathMock(...args),
}));
vi.mock("../config/sessions/store.js", () => ({
  loadSessionStore: (...args: unknown[]) => loadSessionStoreMock(...args),
  resolveSessionStoreEntry: (...args: unknown[]) => resolveSessionStoreEntryMock(...args),
}));
vi.mock("../plugins/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/tools.js")>();
  return {
    ...actual,
    resolvePluginTools: (...args: unknown[]) => resolvePluginToolsMock(...args),
  };
});

async function connectServer(opts?: {
  sessionKey?: string;
  agentId?: string;
  agentTools?: AnyAgentTool[];
  pluginTools?: AnyAgentTool[];
}) {
  const server = createOpenClawAgentMcpServer({
    agentTools: opts?.agentTools,
    pluginTools: opts?.pluginTools,
    sessionContext: {
      sessionKey: opts?.sessionKey ?? "agent:main:telegram:direct:123",
      agentId: opts?.agentId ?? "main",
      accountId: "default",
      gatewayUrl: undefined,
      gatewayToken: undefined,
    },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

beforeEach(() => {
  callGatewayCliMock.mockReset();
  callGatewayMock.mockReset();
  loadSessionStoreMock.mockReset();
  resolveSessionStoreEntryMock.mockReset();
  resolveStorePathMock.mockReset();
  resolvePluginToolsMock.mockReset();
  resolveStorePathMock.mockReturnValue("/tmp/openclaw-sessions.json");
  loadSessionStoreMock.mockReturnValue({});
  resolveSessionStoreEntryMock.mockImplementation(
    ({ store, sessionKey }: { store: Record<string, unknown>; sessionKey: string }) => ({
      normalizedKey: sessionKey,
      existing: store[sessionKey],
      legacyKeys: [],
    }),
  );
  resolvePluginToolsMock.mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openclaw agent MCP server", () => {
  it("lists all built-in tools", async () => {
    const session = await connectServer();
    try {
      const listed = await session.client.listTools();
      const names = listed.tools.map((t) => t.name);
      expect(names).toContain("openclaw_send");
      expect(names).toContain("openclaw_reply");
      expect(names).toContain("openclaw_read_history");
      expect(names).toContain("openclaw_conversations_list");
      expect(names).toContain("openclaw_session_status");
      expect(names).toContain("openclaw_session_close");
      expect(names).toContain("openclaw_spawn_agent");
      expect(names).toContain("openclaw_cron_list");
      expect(names).toContain("openclaw_cron_add");
      expect(names).toContain("openclaw_cron_remove");
      expect(names).toContain("openclaw_cron_run");
      expect(names).toContain("openclaw_image_generate");
      expect(names).toContain("openclaw_tts");
      expect(names).toContain("openclaw_web_search");
      expect(names).toContain("openclaw_web_fetch");
      expect(names).toContain("openclaw_node_list");
      expect(names).toContain("openclaw_node_invoke");
      expect(names).toContain("openclaw_agents_list");
      expect(names).toContain("openclaw_config_get");
      expect(names).toContain("openclaw_channels_status");
      expect(names).toContain("openclaw_approval_list");
      expect(names).toContain("openclaw_approval_resolve");
      expect(names).toContain("openclaw_models_list");
    } finally {
      await session.close();
    }
  });

  it("describes ACP spawn routing and OpenClaw agent discovery correctly", async () => {
    const session = await connectServer();
    try {
      const listed = await session.client.listTools();
      const spawnTool = listed.tools.find((tool) => tool.name === "openclaw_spawn_agent");
      const agentsListTool = listed.tools.find((tool) => tool.name === "openclaw_agents_list");
      expect(spawnTool?.description).toContain("Do this in Claude Code");
      expect(spawnTool?.description).toContain("omit `agentId`");
      expect(spawnTool?.description).toContain("before using direct WebSearch yourself");
      expect(agentsListTool?.description).toContain("not ACP harness discovery");
      expect(agentsListTool?.description).toContain("not for polling loops");
    } finally {
      await session.close();
    }
  });

  it("openclaw_send calls gateway send method", async () => {
    callGatewayCliMock.mockResolvedValue({ ok: true, messageId: "msg-1" });

    const session = await connectServer();
    try {
      const result = await session.client.callTool({
        name: "openclaw_send",
        arguments: {
          channel: "telegram",
          to: "12345",
          message: "Hello from MCP",
        },
      });
      expect(callGatewayCliMock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "send",
          params: expect.objectContaining({
            channel: "telegram",
            to: "12345",
            message: "Hello from MCP",
          }),
        }),
      );
      expect(result.isError).toBeUndefined();
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(JSON.parse(text)).toEqual({ ok: true, messageId: "msg-1" });
    } finally {
      await session.close();
    }
  });

  it("openclaw_reply routes replies through send using the bound session delivery target", async () => {
    callGatewayCliMock.mockResolvedValue({ ok: true });
    loadSessionStoreMock.mockReturnValue({
      "agent:main:acp:uuid-reply": {
        sessionId: "session-reply",
        updatedAt: 1,
        deliveryContext: {
          channel: "telegram",
          to: "12345",
          accountId: "acct-1",
          threadId: 42,
        },
      },
    });

    const session = await connectServer({ sessionKey: "agent:main:acp:uuid-reply" });
    try {
      await session.client.callTool({
        name: "openclaw_reply",
        arguments: { message: "Got it" },
      });
      expect(callGatewayCliMock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "send",
          params: expect.objectContaining({
            channel: "telegram",
            to: "12345",
            accountId: "acct-1",
            threadId: "42",
            sessionKey: "agent:main:acp:uuid-reply",
            message: "Got it",
          }),
        }),
      );
      expect(callGatewayCliMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ method: "agent" }),
      );
    } finally {
      await session.close();
    }
  });

  it("openclaw_session_close delivers message through send then deletes session", async () => {
    callGatewayCliMock.mockResolvedValue({});
    loadSessionStoreMock.mockReturnValue({
      "agent:main:acp:uuid-1": {
        sessionId: "session-close",
        updatedAt: 1,
        deliveryContext: {
          channel: "discord",
          to: "channel:ops-room",
          accountId: "acct-discord",
        },
      },
    });

    const session = await connectServer({ sessionKey: "agent:main:acp:uuid-1" });
    try {
      const result = await session.client.callTool({
        name: "openclaw_session_close",
        arguments: { message: "Task complete — summary here" },
      });
      // First call: deliver handoff message
      expect(callGatewayCliMock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "send",
          params: expect.objectContaining({
            channel: "discord",
            to: "channel:ops-room",
            accountId: "acct-discord",
            sessionKey: "agent:main:acp:uuid-1",
            message: "Task complete — summary here",
          }),
        }),
      );
      // Second call: delete session
      expect(callGatewayCliMock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "sessions.delete",
          params: expect.objectContaining({
            key: "agent:main:acp:uuid-1",
          }),
        }),
      );
      expect(result.isError).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it("openclaw_session_close without message skips delivery", async () => {
    callGatewayCliMock.mockResolvedValue({});

    const session = await connectServer({ sessionKey: "agent:main:acp:uuid-2" });
    try {
      await session.client.callTool({
        name: "openclaw_session_close",
        arguments: {},
      });
      expect(callGatewayCliMock).toHaveBeenCalledTimes(1);
      expect(callGatewayCliMock).toHaveBeenCalledWith(
        expect.objectContaining({ method: "sessions.delete" }),
      );
    } finally {
      await session.close();
    }
  });

  it("openclaw_session_close still deletes the session when no delivery target exists", async () => {
    callGatewayCliMock.mockResolvedValue({});
    loadSessionStoreMock.mockReturnValue({
      "agent:main:acp:uuid-3": {
        sessionId: "session-close-no-target",
        updatedAt: 1,
      },
    });

    const session = await connectServer({ sessionKey: "agent:main:acp:uuid-3" });
    try {
      await session.client.callTool({
        name: "openclaw_session_close",
        arguments: { message: "Please continue with the general assistant." },
      });
      expect(callGatewayCliMock).toHaveBeenCalledTimes(1);
      expect(callGatewayCliMock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "sessions.delete",
          params: expect.objectContaining({
            key: "agent:main:acp:uuid-3",
          }),
        }),
      );
    } finally {
      await session.close();
    }
  });

  it("returns error when session key is missing for session-scoped tools", async () => {
    const session = await connectServer({ sessionKey: undefined });
    try {
      // MCP SDK may throw on malformed error responses; either way we expect failure
      try {
        const result = await session.client.callTool({
          name: "openclaw_reply",
          arguments: { message: "test" },
        });
        // If it doesn't throw, check for error flag
        expect(result.isError).toBe(true);
      } catch (err) {
        // MCP SDK validation error is also acceptable — the tool returned an error
        expect(String(err)).toMatch(/session key|Invalid/i);
      }
    } finally {
      await session.close();
    }
  });

  it("openclaw_spawn_agent uses the internal sessions_spawn tool with ACP runtime", async () => {
    const execute = vi.fn().mockResolvedValue({ content: "spawned" });
    const session = await connectServer({
      agentTools: [
        {
          name: "sessions_spawn",
          description: "Spawn",
          parameters: { type: "object", properties: {} },
          execute,
        } as unknown as AnyAgentTool,
      ],
    });
    try {
      const result = await session.client.callTool({
        name: "openclaw_spawn_agent",
        arguments: {
          agentId: "researcher",
          task: "Investigate the failing build",
          thread: true,
        },
      });
      expect(execute).toHaveBeenCalledWith(
        expect.stringMatching(/^mcp-sessions_spawn-/),
        expect.objectContaining({
          agentId: "researcher",
          task: "Investigate the failing build",
          thread: true,
          runtime: "acp",
        }),
      );
      expect(result.content).toEqual([{ type: "text", text: "spawned" }]);
    } finally {
      await session.close();
    }
  });

  it("openclaw_spawn_agent can omit agentId and rely on the ACP default agent", async () => {
    const execute = vi.fn().mockResolvedValue({ content: "spawned" });
    const session = await connectServer({
      agentTools: [
        {
          name: "sessions_spawn",
          description: "Spawn",
          parameters: { type: "object", properties: {} },
          execute,
        } as unknown as AnyAgentTool,
      ],
    });
    try {
      await session.client.callTool({
        name: "openclaw_spawn_agent",
        arguments: {
          task: "Research the failing build",
        },
      });
      expect(execute).toHaveBeenCalledWith(
        expect.stringMatching(/^mcp-sessions_spawn-/),
        expect.objectContaining({
          task: "Research the failing build",
          runtime: "acp",
        }),
      );
      expect(execute.mock.calls[0]?.[1]).not.toHaveProperty("agentId");
    } finally {
      await session.close();
    }
  });

  it("hides raw wrapped core tools from the OpenClaw MCP surface", async () => {
    const session = await connectServer({
      pluginTools: [
        {
          name: "sessions_spawn",
          description: "raw spawn",
          parameters: { type: "object", properties: {} },
          execute: vi.fn(),
        } as unknown as AnyAgentTool,
        {
          name: "web_search",
          description: "raw search",
          parameters: { type: "object", properties: {} },
          execute: vi.fn(),
        } as unknown as AnyAgentTool,
      ],
    });
    try {
      const listed = await session.client.listTools();
      const names = new Set(listed.tools.map((tool) => tool.name));
      expect(names.has("openclaw_spawn_agent")).toBe(true);
      expect(names.has("openclaw_web_search")).toBe(true);
      expect(names.has("sessions_spawn")).toBe(false);
      expect(names.has("web_search")).toBe(false);
    } finally {
      await session.close();
    }
  });

  it.each([
    ["openclaw_image_generate", "image_generate", { prompt: "draw a cat" }],
    ["openclaw_web_search", "web_search", { query: "openclaw docs" }],
    ["openclaw_web_fetch", "web_fetch", { url: "https://example.com" }],
  ])("%s executes the internal %s tool runtime", async (mcpToolName, internalToolName, args) => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: `${internalToolName} ok` }],
    });
    const session = await connectServer({
      agentTools: [
        {
          name: internalToolName,
          description: internalToolName,
          parameters: { type: "object", properties: {} },
          execute,
        } as unknown as AnyAgentTool,
      ],
    });
    try {
      const result = await session.client.callTool({
        name: mcpToolName,
        arguments: args,
      });
      expect(execute).toHaveBeenCalledWith(expect.stringMatching(/^mcp-/), args);
      expect(result.content).toEqual([{ type: "text", text: `${internalToolName} ok` }]);
    } finally {
      await session.close();
    }
  });

  it("handles gateway errors gracefully", async () => {
    callGatewayCliMock.mockRejectedValue(new Error("connection refused"));

    const session = await connectServer();
    try {
      const result = await session.client.callTool({
        name: "openclaw_channels_status",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain("connection refused");
    } finally {
      await session.close();
    }
  });

  it("includes plugin tools alongside built-in tools", async () => {
    const pluginTool = {
      name: "memory_recall",
      description: "Recall stored memory",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "memory result" }] }),
    } as unknown as AnyAgentTool;

    const session = await connectServer({ pluginTools: [pluginTool] });
    try {
      const listed = await session.client.listTools();
      const names = listed.tools.map((t) => t.name);
      expect(names).toContain("openclaw_send");
      expect(names).toContain("memory_recall");

      const result = await session.client.callTool({
        name: "memory_recall",
        arguments: { query: "test" },
      });
      expect(pluginTool.execute).toHaveBeenCalled();
      expect(result.content).toEqual([{ type: "text", text: "memory result" }]);
    } finally {
      await session.close();
    }
  });

  it("resolves plugin tools with active MCP session runtime context", async () => {
    loadSessionStoreMock.mockReturnValue({
      "agent:main:acp:plugin-ctx": {
        sessionId: "plugin-session",
        updatedAt: 1,
        groupId: "group-1",
        groupChannel: "ops",
        space: "space-1",
        deliveryContext: {
          channel: "telegram",
          to: "channel:-100123",
          accountId: "acct-7",
          threadId: 77,
        },
      },
    });
    resolvePluginToolsMock.mockReturnValue([
      {
        name: "plugin_lookup",
        description: "Lookup plugin data",
        parameters: { type: "object", properties: {} },
        execute: vi.fn().mockResolvedValue({ content: "ok" }),
      } as unknown as AnyAgentTool,
    ]);

    const session = await connectServer({ sessionKey: "agent:main:acp:plugin-ctx" });
    try {
      const listed = await session.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain("plugin_lookup");
      expect(resolvePluginToolsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            sessionKey: "agent:main:acp:plugin-ctx",
            agentId: "main",
            sessionId: "plugin-session",
            workspaceDir: process.cwd(),
            messageChannel: "telegram",
            agentAccountId: "acct-7",
            deliveryContext: {
              channel: "telegram",
              to: "channel:-100123",
              accountId: "acct-7",
              threadId: 77,
            },
          }),
          suppressNameConflicts: true,
        }),
      );
    } finally {
      await session.close();
    }
  });

  it("openclaw_cron_add calls gateway cron.add", async () => {
    callGatewayCliMock.mockResolvedValue({ ok: true });

    const session = await connectServer();
    try {
      await session.client.callTool({
        name: "openclaw_cron_add",
        arguments: {
          name: "daily-summary",
          schedule: "0 9 * * *",
          task: "Summarize yesterday's messages",
        },
      });
      expect(callGatewayCliMock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "cron.add",
          params: expect.objectContaining({
            name: "daily-summary",
            schedule: "0 9 * * *",
            task: "Summarize yesterday's messages",
          }),
        }),
      );
    } finally {
      await session.close();
    }
  });
});

describe("resolveSessionContext", () => {
  it("prefers env vars when session key is set", () => {
    const ctx = resolveSessionContext({
      OPENCLAW_SESSION_KEY: "agent:main:telegram:direct:123",
      OPENCLAW_AGENT_ID: "main",
      OPENCLAW_ACCOUNT_ID: "default",
    });
    expect(ctx.sessionKey).toBe("agent:main:telegram:direct:123");
    expect(ctx.agentId).toBe("main");
  });

  it("falls back to workspace file when env has no session key", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ctx-test-"));
    try {
      const ctxDir = path.join(tmpDir, ".openclaw");
      fs.mkdirSync(ctxDir, { recursive: true });
      fs.writeFileSync(
        path.join(ctxDir, "mcp-session-context.json"),
        JSON.stringify({
          sessionKey: "agent:main:acp:file-uuid",
          agentId: "main",
          accountId: "file-account",
        }),
      );

      const ctx = resolveSessionContext({}, tmpDir);
      expect(ctx.sessionKey).toBe("agent:main:acp:file-uuid");
      expect(ctx.agentId).toBe("main");
      expect(ctx.accountId).toBe("file-account");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty context when neither env nor file has session key", () => {
    const ctx = resolveSessionContext({}, "/nonexistent/path");
    expect(ctx.sessionKey).toBeUndefined();
  });
});

describe("isOpenClawAgentServeEntrypoint", () => {
  it("matches Windows bundled entry paths by normalized suffix", () => {
    expect(
      isOpenClawAgentServeEntrypoint(
        "file:///bundle/chunk.js",
        "C:\\repo\\dist\\mcp\\openclaw-agent-serve.js",
      ),
    ).toBe(true);
  });
});
