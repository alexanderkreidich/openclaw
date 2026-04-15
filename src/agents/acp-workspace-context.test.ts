import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_SESSION_CONTEXT_FILENAME } from "../mcp/openclaw-agent-serve.js";
import {
  ensureAcpWorkspaceContext,
  removeAcpSessionContext,
  writeAcpSessionContext,
} from "./acp-workspace-context.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-workspace-ctx-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("ensureAcpWorkspaceContext", () => {
  it("creates CLAUDE.md when none exists", async () => {
    await ensureAcpWorkspaceContext(tmpDir);

    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("<!-- openclaw:generated -->");
    expect(content).toContain("AGENTS.md");
    expect(content).toContain("SOUL.md");
    expect(content).toContain("IDENTITY.md");
    expect(content).toContain("USER.md");
    expect(content).toContain("TOOLS.md");
    expect(content).toContain("MEMORY.md");
    expect(content).toContain("openclaw_session_close");
  });

  it("does not overwrite user-managed CLAUDE.md", async () => {
    const userContent = "# My Custom Instructions\n\nDo things my way.\n";
    await fs.writeFile(path.join(tmpDir, "CLAUDE.md"), userContent, "utf-8");

    await ensureAcpWorkspaceContext(tmpDir);

    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");
    expect(content).toBe(userContent);
  });

  it("updates a previously generated CLAUDE.md", async () => {
    // Write an old generated version
    await fs.writeFile(
      path.join(tmpDir, "CLAUDE.md"),
      "<!-- openclaw:generated -->\n# Old Version\n",
      "utf-8",
    );

    await ensureAcpWorkspaceContext(tmpDir);

    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("<!-- openclaw:generated -->");
    expect(content).toContain("OpenClaw Workspace");
    expect(content).not.toContain("Old Version");
  });

  it("is non-fatal when workspace directory does not exist", async () => {
    const nonexistent = path.join(tmpDir, "does-not-exist");

    // Should not throw
    await ensureAcpWorkspaceContext(nonexistent);
  });

  it("is idempotent — running twice produces same result", async () => {
    await ensureAcpWorkspaceContext(tmpDir);
    const first = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");

    await ensureAcpWorkspaceContext(tmpDir);
    const second = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");

    expect(first).toBe(second);
  });

  it("includes MCP tool catalog", async () => {
    await ensureAcpWorkspaceContext(tmpDir);
    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");

    expect(content).toContain("## MCP Tools");
    expect(content).toContain("openclaw_reply");
    expect(content).toContain("openclaw_send");
    expect(content).toContain("openclaw_spawn_agent");
    expect(content).toContain("openclaw_cron_add");
    expect(content).toContain("openclaw_image_generate");
    expect(content).toContain("openclaw_web_search");
    expect(content).toContain("openclaw_models_list");
  });

  it("includes ACP delegation routing and no-poll rules", async () => {
    await ensureAcpWorkspaceContext(tmpDir);
    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");

    expect(content).toContain("## Delegation Rules");
    expect(content).toContain('If the user explicitly says "Do this in Claude Code"');
    expect(content).toContain("omit `agentId` to use the configured default agent");
    expect(content).toContain(
      "use it for ordinary delegation requests instead of raw `sessions_spawn`",
    );
    expect(content).toContain("do not substitute built-in WebSearch/openclaw_web_search");
    expect(content).toContain("do not poll sub-agents in a loop");
    expect(content).toContain("not ACP harness discovery");
  });

  it("includes identity section with agent name when provided", async () => {
    await ensureAcpWorkspaceContext(tmpDir, {
      agentIdentity: { name: "Skredik", emoji: "🦞" },
    });
    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");

    expect(content).toContain("You are **Skredik**");
    expect(content).toContain("Read SOUL.md");
    expect(content).toContain("Read IDENTITY.md");
  });

  it("includes generic identity when no agent name provided", async () => {
    await ensureAcpWorkspaceContext(tmpDir);
    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");

    expect(content).toContain("You are a personal assistant running inside OpenClaw.");
    expect(content).not.toContain("You are **");
  });

  it("includes heartbeat section when heartbeatEnabled is true", async () => {
    await ensureAcpWorkspaceContext(tmpDir, { heartbeatEnabled: true });
    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");

    expect(content).toContain("## Heartbeat Protocol");
    expect(content).toContain("reply with exactly `HEARTBEAT_OK` and nothing else");
    expect(content).toContain("HEARTBEAT.md");
  });

  it("omits heartbeat section when heartbeatEnabled is false", async () => {
    await ensureAcpWorkspaceContext(tmpDir, { heartbeatEnabled: false });
    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");

    expect(content).not.toContain("## Heartbeat Protocol");
  });

  it("includes output directives, execution bias, safety, and memory sections", async () => {
    await ensureAcpWorkspaceContext(tmpDir);
    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");

    expect(content).toContain("## Output Directives");
    expect(content).toContain("MEDIA:");
    expect(content).toContain("[[audio_as_voice]]");
    expect(content).toContain("[[reply_to_current]]` MUST be the very first token");
    expect(content).toContain("output exactly `NO_REPLY` and nothing else");
    expect(content).toContain("openclaw_image_generate");
    expect(content).toContain("openclaw_tts");
    expect(content).toContain("## Execution Bias");
    expect(content).toContain("## Safety");
    expect(content).toContain("## Memory");
    expect(content).toContain("use `openclaw_read_history` before answering");
  });

  it("includes close-vs-followup session lifecycle guidance", async () => {
    await ensureAcpWorkspaceContext(tmpDir);
    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");

    expect(content).toContain("When the user confirms completion");
    expect(content).toContain("off-topic request outside your scope");
    expect(content).toContain("Do NOT close the session while still working");
  });

  it("includes runtime info when agentId is provided", async () => {
    await ensureAcpWorkspaceContext(tmpDir, { agentId: "main", runtimeChannel: "discord" });
    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");

    expect(content).toContain("## Runtime");
    expect(content).toContain("Agent ID: `main`");
    expect(content).toContain("Channel: `discord`");
  });

  it("backward compat: no options still generates valid CLAUDE.md", async () => {
    await ensureAcpWorkspaceContext(tmpDir);
    const content = await fs.readFile(path.join(tmpDir, "CLAUDE.md"), "utf-8");

    expect(content).toContain("<!-- openclaw:generated -->");
    expect(content).toContain("## MCP Tools");
    expect(content).toContain("## Session Control");
    expect(content).toContain("openclaw_session_close");
  });
});

describe("writeAcpSessionContext", () => {
  it("writes session context file to workspace", async () => {
    await writeAcpSessionContext(tmpDir, {
      sessionKey: "agent:main:acp:uuid-1",
      agentId: "main",
      accountId: "default",
    });

    const filePath = path.join(tmpDir, MCP_SESSION_CONTEXT_FILENAME);
    const raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(raw.sessionKey).toBe("agent:main:acp:uuid-1");
    expect(raw.agentId).toBe("main");
    expect(raw.accountId).toBe("default");
    expect(raw.gatewayUrl).toBeUndefined();
  });

  it("includes optional gateway fields when provided", async () => {
    await writeAcpSessionContext(tmpDir, {
      sessionKey: "agent:main:acp:uuid-2",
      agentId: "main",
      accountId: "default",
      gatewayUrl: "ws://127.0.0.1:18789",
      gatewayToken: "tok-123",
    });

    const filePath = path.join(tmpDir, MCP_SESSION_CONTEXT_FILENAME);
    const raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(raw.gatewayUrl).toBe("ws://127.0.0.1:18789");
    expect(raw.gatewayToken).toBe("tok-123");
  });

  it("creates .openclaw directory if missing", async () => {
    await writeAcpSessionContext(tmpDir, {
      sessionKey: "agent:main:acp:uuid-3",
      agentId: "main",
      accountId: "default",
    });

    const dirExists = await fs
      .access(path.join(tmpDir, ".openclaw"))
      .then(() => true)
      .catch(() => false);
    expect(dirExists).toBe(true);
  });

  it("is non-fatal when workspace directory does not exist", async () => {
    const nonexistent = path.join(tmpDir, "does-not-exist", "nested");
    // Should not throw
    await writeAcpSessionContext(nonexistent, {
      sessionKey: "agent:main:acp:uuid-4",
      agentId: "main",
      accountId: "default",
    });
  });
});

describe("removeAcpSessionContext", () => {
  it("removes existing context file", async () => {
    await writeAcpSessionContext(tmpDir, {
      sessionKey: "agent:main:acp:uuid-5",
      agentId: "main",
      accountId: "default",
    });

    await removeAcpSessionContext(tmpDir);

    const exists = await fs
      .access(path.join(tmpDir, MCP_SESSION_CONTEXT_FILENAME))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("is non-fatal when file does not exist", async () => {
    // Should not throw
    await removeAcpSessionContext(tmpDir);
  });
});
