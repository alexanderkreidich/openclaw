/**
 * Auto-initializes ACP sessions for the reply pipeline.
 *
 * When configured (`acp.defaultAgent` is set, ACP dispatch is enabled),
 * this adapter creates ACP sessions on-demand for regular message replies,
 * routing them through Claude Code (or another ACP agent) instead of the
 * embedded Pi inference loop.
 *
 * Pre-session setup:
 *   1. ensureAcpWorkspaceContext() — creates CLAUDE.md referencing bootstrap files
 *   2. writeAcpSessionContext() — writes MCP session context for the unified MCP server
 *   3. initializeSession() — creates the ACP session via the control plane
 */
import { resolveAcpDispatchPolicyError } from "../acp/policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  ensureAcpWorkspaceContext,
  removeAcpSessionContext,
  writeAcpSessionContext,
} from "./acp-workspace-context.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "./agent-scope.js";
import { shouldIncludeHeartbeatGuidanceForSystemPrompt } from "./heartbeat-system-prompt.js";

const log = createSubsystemLogger("agents/acp-session-adapter");

/**
 * Checks whether ACP sessions should be auto-initialized for regular replies.
 *
 * Returns `true` when all of:
 *   - `acp.enabled` is not `false`
 *   - `acp.dispatch.enabled` is not `false`
 *   - `acp.defaultAgent` is set (the explicit opt-in)
 */
export function shouldAutoInitAcpSession(cfg: OpenClawConfig): boolean {
  if (cfg.acp?.enabled === false) {
    return false;
  }
  if (cfg.acp?.dispatch?.enabled === false) {
    return false;
  }
  return Boolean(normalizeOptionalString(cfg.acp?.defaultAgent));
}

/**
 * Resolves the ACP agent id for auto-init.
 * Prefers `acp.defaultAgent` (the explicit auto-init opt-in), then falls back
 * to the session-key-derived agent when it differs from "main" (the generic
 * default that is not a real ACP agent name).
 */
function resolveAutoInitAgentId(cfg: OpenClawConfig, sessionKey: string): string | undefined {
  const defaultAgent = normalizeOptionalString(cfg.acp?.defaultAgent);
  if (defaultAgent) {
    return defaultAgent;
  }
  const sessionAgent = normalizeOptionalString(resolveAgentIdFromSessionKey(sessionKey));
  return sessionAgent && sessionAgent !== "main" ? sessionAgent : undefined;
}

export type AutoInitAcpSessionParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  accountId?: string;
};

export type AutoInitAcpSessionResult =
  | { ok: true; workspaceDir: string; agentId: string }
  | { ok: false; error: string };

/**
 * Auto-initializes an ACP session for the given session key.
 *
 * 1. Resolves workspace directory from agent config
 * 2. Writes CLAUDE.md workspace context (`ensureAcpWorkspaceContext`)
 * 3. Writes MCP session context file (`writeAcpSessionContext`)
 * 4. Initializes ACP session via the control plane (`initializeSession`)
 */
export async function autoInitializeAcpSession(
  params: AutoInitAcpSessionParams,
): Promise<AutoInitAcpSessionResult> {
  const { cfg, sessionKey } = params;

  const policyError = resolveAcpDispatchPolicyError(cfg);
  if (policyError) {
    return { ok: false, error: policyError.message };
  }

  const agentId = resolveAutoInitAgentId(cfg, sessionKey);
  if (!agentId) {
    return { ok: false, error: "No ACP agent resolvable for auto-init." };
  }

  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  try {
    // Resolve agent config for identity + heartbeat options.
    const agentCfg = resolveAgentConfig(cfg, agentId);
    const heartbeatEnabled = shouldIncludeHeartbeatGuidanceForSystemPrompt({
      config: cfg,
      agentId,
    });

    // Write workspace context files before session creation so the
    // unified MCP server can discover per-session identity.
    await ensureAcpWorkspaceContext(workspaceDir, {
      agentId,
      agentIdentity: agentCfg?.identity
        ? { name: agentCfg.identity.name, emoji: agentCfg.identity.emoji }
        : undefined,
      heartbeatEnabled,
    });
    await writeAcpSessionContext(workspaceDir, {
      sessionKey,
      agentId,
      accountId: params.accountId ?? "",
    });

    // Initialize ACP session via the control plane.
    const { getAcpSessionManager } = await import("../acp/control-plane/manager.js");
    const manager = getAcpSessionManager();
    await manager.initializeSession({
      cfg,
      sessionKey,
      agent: agentId,
      mode: "persistent",
      cwd: workspaceDir,
      backendId: cfg.acp?.backend,
    });

    log.info("auto-initialized ACP session", { sessionKey, agentId, workspaceDir });
    return { ok: true, workspaceDir, agentId };
  } catch (err) {
    await removeAcpSessionContext(workspaceDir);
    const message = err instanceof Error ? err.message : String(err);
    log.warn("failed to auto-initialize ACP session", { sessionKey, agentId, error: message });
    return { ok: false, error: message };
  }
}
