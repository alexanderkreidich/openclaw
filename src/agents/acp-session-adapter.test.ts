import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { autoInitializeAcpSession, shouldAutoInitAcpSession } from "./acp-session-adapter.js";

const mockResolveAcpDispatchPolicyError = vi.fn().mockReturnValue(undefined);
vi.mock("../acp/policy.js", () => ({
  resolveAcpDispatchPolicyError: (...args: unknown[]) => mockResolveAcpDispatchPolicyError(...args),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockResolveAgentConfig = vi.fn().mockReturnValue(undefined);
vi.mock("./agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/test-workspace"),
  resolveAgentConfig: (...args: unknown[]) => mockResolveAgentConfig(...args),
}));

const mockShouldIncludeHeartbeatGuidance = vi.fn().mockReturnValue(false);
vi.mock("./heartbeat-system-prompt.js", () => ({
  shouldIncludeHeartbeatGuidanceForSystemPrompt: (...args: unknown[]) =>
    mockShouldIncludeHeartbeatGuidance(...args),
}));

const mockEnsureAcpWorkspaceContext = vi.fn().mockResolvedValue(undefined);
const mockWriteAcpSessionContext = vi.fn().mockResolvedValue(undefined);
const mockRemoveAcpSessionContext = vi.fn().mockResolvedValue(undefined);

vi.mock("./acp-workspace-context.js", () => ({
  ensureAcpWorkspaceContext: (...args: unknown[]) => mockEnsureAcpWorkspaceContext(...args),
  writeAcpSessionContext: (...args: unknown[]) => mockWriteAcpSessionContext(...args),
  removeAcpSessionContext: (...args: unknown[]) => mockRemoveAcpSessionContext(...args),
}));

const mockInitializeSession = vi.fn().mockResolvedValue({
  runtime: {},
  handle: {},
  meta: { state: "idle" },
});

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    initializeSession: (...args: unknown[]) => mockInitializeSession(...args),
  }),
}));

function cfgWith(acp: OpenClawConfig["acp"]): OpenClawConfig {
  return { acp } as OpenClawConfig;
}

// ---------------------------------------------------------------------------
// shouldAutoInitAcpSession
// ---------------------------------------------------------------------------

describe("shouldAutoInitAcpSession", () => {
  it("returns true when acp.defaultAgent is set and ACP is enabled", () => {
    expect(shouldAutoInitAcpSession(cfgWith({ defaultAgent: "claudecode" }))).toBe(true);
  });

  it("returns false when acp is undefined", () => {
    expect(shouldAutoInitAcpSession(cfgWith(undefined))).toBe(false);
  });

  it("returns false when acp.defaultAgent is not set", () => {
    expect(shouldAutoInitAcpSession(cfgWith({ enabled: true }))).toBe(false);
  });

  it("returns false when acp.enabled is false", () => {
    expect(shouldAutoInitAcpSession(cfgWith({ enabled: false, defaultAgent: "claudecode" }))).toBe(
      false,
    );
  });

  it("returns false when acp.dispatch.enabled is false", () => {
    expect(
      shouldAutoInitAcpSession(
        cfgWith({ defaultAgent: "claudecode", dispatch: { enabled: false } }),
      ),
    ).toBe(false);
  });

  it("returns true when dispatch is not explicitly disabled", () => {
    expect(shouldAutoInitAcpSession(cfgWith({ defaultAgent: "claudecode", dispatch: {} }))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// autoInitializeAcpSession
// ---------------------------------------------------------------------------

describe("autoInitializeAcpSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAcpDispatchPolicyError.mockReturnValue(undefined);
    mockEnsureAcpWorkspaceContext.mockResolvedValue(undefined);
    mockWriteAcpSessionContext.mockResolvedValue(undefined);
    mockRemoveAcpSessionContext.mockResolvedValue(undefined);
    mockInitializeSession.mockResolvedValue({
      runtime: {},
      handle: {},
      meta: { state: "idle" },
    });
  });

  it("initializes an ACP session with workspace context", async () => {
    const result = await autoInitializeAcpSession({
      cfg: cfgWith({ defaultAgent: "claude" }),
      sessionKey: "agent:main:telegram:123",
      accountId: "acc-1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspaceDir).toBe("/tmp/test-workspace");
      expect(result.agentId).toBe("claude");
    }

    expect(mockEnsureAcpWorkspaceContext).toHaveBeenCalledWith("/tmp/test-workspace", {
      agentId: "claude",
      agentIdentity: undefined,
      heartbeatEnabled: false,
    });
    expect(mockWriteAcpSessionContext).toHaveBeenCalledWith("/tmp/test-workspace", {
      sessionKey: "agent:main:telegram:123",
      agentId: "claude",
      accountId: "acc-1",
    });
    expect(mockInitializeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:123",
        agent: "claude",
        mode: "persistent",
        cwd: "/tmp/test-workspace",
      }),
    );
  });

  it("prefers defaultAgent over session-key agent", async () => {
    const result = await autoInitializeAcpSession({
      cfg: cfgWith({ defaultAgent: "claude" }),
      sessionKey: "agent:ops:telegram:123",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agentId).toBe("claude");
    }
  });

  it("fails when dispatch policy blocks", async () => {
    mockResolveAcpDispatchPolicyError.mockReturnValue({
      message: "ACP dispatch is disabled.",
      code: "ACP_DISPATCH_DISABLED",
    });

    const result = await autoInitializeAcpSession({
      cfg: cfgWith({ defaultAgent: "claudecode" }),
      sessionKey: "agent:main:test:1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ACP dispatch is disabled");
    }
  });

  it("fails when dispatch policy rejects", async () => {
    mockResolveAcpDispatchPolicyError.mockReturnValue({
      message: "ACP dispatch is not available.",
      code: "ACP_DISPATCH_DISABLED",
    });

    const result = await autoInitializeAcpSession({
      cfg: cfgWith({ defaultAgent: "claudecode" }),
      sessionKey: "agent:main:test:2",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not available");
    }
  });

  it("cleans up session context on initializeSession failure", async () => {
    mockInitializeSession.mockRejectedValueOnce(new Error("backend not configured"));

    const result = await autoInitializeAcpSession({
      cfg: cfgWith({ defaultAgent: "claudecode" }),
      sessionKey: "agent:main:test:1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("backend not configured");
    }
    expect(mockRemoveAcpSessionContext).toHaveBeenCalledWith("/tmp/test-workspace");
  });

  it("passes acp.backend as backendId", async () => {
    await autoInitializeAcpSession({
      cfg: cfgWith({ defaultAgent: "claudecode", backend: "acpx" }),
      sessionKey: "agent:main:test:1",
    });

    expect(mockInitializeSession).toHaveBeenCalledWith(
      expect.objectContaining({ backendId: "acpx" }),
    );
  });

  it("passes agent identity to workspace context when available", async () => {
    mockResolveAgentConfig.mockReturnValue({
      identity: { name: "Skredik", emoji: "🦞" },
    });

    await autoInitializeAcpSession({
      cfg: cfgWith({ defaultAgent: "claude" }),
      sessionKey: "agent:main:test:1",
    });

    expect(mockEnsureAcpWorkspaceContext).toHaveBeenCalledWith(
      "/tmp/test-workspace",
      expect.objectContaining({
        agentId: "claude",
        agentIdentity: { name: "Skredik", emoji: "🦞" },
      }),
    );
  });

  it("passes heartbeatEnabled when heartbeat guidance is active", async () => {
    mockShouldIncludeHeartbeatGuidance.mockReturnValue(true);

    await autoInitializeAcpSession({
      cfg: cfgWith({ defaultAgent: "claude" }),
      sessionKey: "agent:main:test:1",
    });

    expect(mockEnsureAcpWorkspaceContext).toHaveBeenCalledWith(
      "/tmp/test-workspace",
      expect.objectContaining({ heartbeatEnabled: true }),
    );
  });
});
