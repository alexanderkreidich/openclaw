import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createOpenClawAgentMcpServer, resolveSessionContext } from "./openclaw-agent-serve.js";

// Mock callGatewayCli
const callGatewayCliMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGatewayCli: (...args: unknown[]) => callGatewayCliMock(...args),
}));

async function connectServer(opts?: {
  sessionKey?: string;
  agentId?: string;
  pluginTools?: AnyAgentTool[];
}) {
  const server = createOpenClawAgentMcpServer({
    pluginTools: opts?.pluginTools ?? [],
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

  it("openclaw_reply uses session key from context", async () => {
    callGatewayCliMock.mockResolvedValue({ ok: true });

    const session = await connectServer({ sessionKey: "agent:main:telegram:direct:999" });
    try {
      await session.client.callTool({
        name: "openclaw_reply",
        arguments: { message: "Got it" },
      });
      expect(callGatewayCliMock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "agent",
          params: expect.objectContaining({
            sessionKey: "agent:main:telegram:direct:999",
            message: "Got it",
            deliver: true,
          }),
        }),
      );
    } finally {
      await session.close();
    }
  });

  it("openclaw_session_close delivers message then deletes session", async () => {
    callGatewayCliMock.mockResolvedValue({});

    const session = await connectServer({ sessionKey: "agent:main:acp:uuid-1" });
    try {
      const result = await session.client.callTool({
        name: "openclaw_session_close",
        arguments: { message: "Task complete — summary here" },
      });
      // First call: deliver handoff message
      expect(callGatewayCliMock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "agent",
          params: expect.objectContaining({
            sessionKey: "agent:main:acp:uuid-1",
            message: "Task complete — summary here",
            deliver: true,
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
