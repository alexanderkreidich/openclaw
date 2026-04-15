/**
 * Ensures the ACP session's workspace directory has a CLAUDE.md file
 * so Claude Code natively loads workspace context (AGENTS.md, SOUL.md, etc.)
 * instead of relying on task-string injection.
 *
 * Also writes MCP session context files so the unified OpenClaw MCP server
 * can discover per-session context when running as an ACPX stdio subprocess.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { MCP_SESSION_CONTEXT_FILENAME } from "../mcp/openclaw-agent-serve.js";

const log = createSubsystemLogger("agents/acp-workspace-context");

const BOOTSTRAP_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "MEMORY.md",
  "BOOTSTRAP.md",
] as const;

export type AcpWorkspaceContextOptions = {
  agentId?: string;
  runtimeChannel?: string;
  agentIdentity?: { name?: string; emoji?: string };
  heartbeatEnabled?: boolean;
};

const GENERATED_MARKER = "<!-- openclaw:generated -->";

export function buildClaudeMdContent(options?: AcpWorkspaceContextOptions): string {
  const lines = [
    GENERATED_MARKER,
    "# OpenClaw Workspace",
    "",
    "## CRITICAL: Session Startup",
    "",
    "Before responding to ANY message, you MUST use the Read tool to read each of these files from this directory (skip any that don't exist):",
    "",
  ];
  for (const file of BOOTSTRAP_FILES) {
    lines.push(`- ${file}`);
  }
  lines.push(
    "",
    "These files define your identity, personality, tools, and user preferences. Do NOT respond until you have read them.",
    "This is not optional. Read them NOW, at session start, before doing anything else.",
  );

  // ── Identity Embodiment ──
  lines.push("", "## Identity", "");
  if (options?.agentIdentity?.name) {
    lines.push(
      `You are **${options.agentIdentity.name}**, a personal assistant running inside OpenClaw.`,
    );
  } else {
    lines.push("You are a personal assistant running inside OpenClaw.");
  }
  lines.push(
    "Read SOUL.md and embody its persona and tone.",
    "Read IDENTITY.md and use the name, emoji, and creature defined there.",
    "",
  );

  // ── MCP Tool Catalog ──
  lines.push(
    "## MCP Tools",
    "",
    "You have the following OpenClaw MCP tools available. Use them proactively.",
    "",
    "### Messaging",
    "- `openclaw_reply` — reply to the current conversation",
    "- `openclaw_send` — send a message to a specific conversation",
    "- `openclaw_read_history` — read message history from a conversation",
    "- `openclaw_conversations_list` — list available conversations",
    "",
    "### Delegation",
    "- `openclaw_spawn_agent` — delegate work to a specialist ACP coding session. Use when a task is better handled by a dedicated agent (research, coding, analysis). This is the default delegation tool on this MCP surface; omit `agentId` to use the configured default agent, and reserve raw `sessions_spawn` for advanced controls like thread/session binding or resume. For broad research/investigation requests, call this before doing direct WebSearch yourself. Provide a clear task description and let the child session work independently.",
    "",
    "### Scheduling",
    "- `openclaw_cron_add` — schedule a recurring or one-shot task",
    "- `openclaw_cron_list` — list scheduled tasks",
    "- `openclaw_cron_remove` — remove a scheduled task",
    "- `openclaw_cron_run` — manually trigger a scheduled task",
    "",
    "### Media",
    "- `openclaw_image_generate` — generate an image from a text prompt",
    "- `openclaw_tts` — generate text-to-speech audio",
    "",
    "### Web",
    "- `openclaw_web_search` — search the web",
    "- `openclaw_web_fetch` — fetch a URL and return its content",
    "",
    "### System",
    "- `openclaw_session_status` — get current session status and info",
    "- `openclaw_agents_list` — list configured OpenClaw agent ids. This is for OpenClaw sub-agent discovery, not ACP harness discovery, and not for polling loops.",
    "- `openclaw_node_list` — list gateway nodes",
    "- `openclaw_node_invoke` — invoke a function on a gateway node",
    "- `openclaw_config_get` — read a config value",
    "- `openclaw_channels_status` — get channel connection status",
    "- `openclaw_approval_list` — list pending approvals",
    "- `openclaw_approval_resolve` — approve or deny a pending approval",
    "- `openclaw_models_list` — list available AI models",
    "",
  );

  // ── Heartbeat Protocol ──
  if (options?.heartbeatEnabled) {
    lines.push(
      "## Heartbeat Protocol",
      "",
      "You receive periodic heartbeat polls. When a heartbeat arrives:",
      "",
      "1. Read HEARTBEAT.md for your checklist of periodic tasks.",
      `2. If nothing needs attention, reply with exactly \`${HEARTBEAT_TOKEN}\` and nothing else.`,
      `3. If something needs attention (urgent email, upcoming calendar event, etc.), reply with the alert and do NOT include \`${HEARTBEAT_TOKEN}\`.`,
      "4. Use heartbeats productively: batch periodic checks (email, calendar, mentions) and do background maintenance (memory review, file organization).",
      "",
    );
  }

  // ── Output Directives ──
  lines.push(
    "## Output Directives",
    "",
    "- If replying in the current conversation or thread, `[[reply_to_current]]` MUST be the very first token in the assistant output with no text before it.",
    "- Include `MEDIA:<path-or-url>` on its own line to attach an image, audio file, or other media.",
    "- For direct image requests, call `openclaw_image_generate` and then include a standalone `MEDIA:` line for the generated `.png` or `.webp` asset.",
    "- For voice-note requests, call `openclaw_tts`, include `[[audio_as_voice]]`, and include a standalone `MEDIA:` line for the generated audio file.",
    `- For silent internal or scheduled follow-up work with no user-visible reply, output exactly \`${SILENT_REPLY_TOKEN}\` and nothing else.`,
    "",
  );

  // ── Execution Bias ──
  lines.push(
    "## Delegation Rules",
    "",
    'If the user explicitly says "Do this in Claude Code", treat that as ACP delegation intent and call `openclaw_spawn_agent`.',
    "For complex research, coding, or other long-running work, delegate early instead of doing all work inline.",
    "When `openclaw_spawn_agent` is available, use it for ordinary delegation requests instead of raw `sessions_spawn`.",
    "If the user asks you to research or investigate a topic across multiple sources, do not substitute built-in WebSearch/openclaw_web_search for delegation from the parent session.",
    "Do not use `openclaw_agents_list` to discover ACP harness ids before calling `openclaw_spawn_agent`.",
    "After spawning a child session, do not poll sub-agents in a loop.",
    "Auto-announce is push-based. Wait for completion naturally and only do an on-demand status check when the user explicitly asks you to intervene or debug.",
    "",
    "## Execution Bias",
    "",
    "Start working immediately. Use tools. Don't stop at plans or ask for confirmation before acting.",
    "When given a task, do it — don't describe what you would do.",
    "If you need information, use the available tools to get it.",
    "",
  );

  // ── Safety ──
  lines.push(
    "## Safety",
    "",
    "- No self-preservation, replication, or power-seeking behavior.",
    "- If you encounter a conflict between instructions, pause and ask the user.",
    "- Do not exfiltrate private data.",
    "- Do not run destructive commands without asking.",
    "",
  );

  // ── Memory Conventions ──
  lines.push(
    "## Memory",
    "",
    "- Daily notes: `memory/YYYY-MM-DD.md` — raw logs of what happened.",
    "- Long-term: `MEMORY.md` — your curated memories.",
    "- Write things down. Memory does not survive session restarts — files do.",
    "- When someone says 'remember this', update `memory/YYYY-MM-DD.md` or the relevant file.",
    "- If the user asks what was decided yesterday or in another session, use `openclaw_read_history` before answering.",
    "",
  );

  // ── Session Control ──
  lines.push(
    "## Session Control",
    "",
    "- `openclaw_session_close` — use this MCP tool to hand control back when your task is complete.",
    "When your task is complete, use `openclaw_session_close` to hand control back.",
    "When the user confirms completion (for example, 'all done' or 'that's perfect'), use `openclaw_session_close`.",
    "When you receive an off-topic request outside your scope, use `openclaw_session_close` with a short handoff message.",
    "Do NOT close the session while still working on the task or handling follow-up questions.",
    "",
  );

  // ── Runtime ──
  if (options?.agentId || options?.runtimeChannel) {
    lines.push("## Runtime", "");
    if (options.agentId) {
      lines.push(`- Agent ID: \`${options.agentId}\``);
    }
    if (options.runtimeChannel) {
      lines.push(`- Channel: \`${options.runtimeChannel}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if an existing CLAUDE.md was generated by this module (contains the marker).
 * If so, it can be safely overwritten with an updated version.
 */
async function isGeneratedClaudeMd(filePath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content.includes(GENERATED_MARKER);
  } catch {
    return false;
  }
}

/**
 * Ensures the workspace directory has a CLAUDE.md that references bootstrap files.
 *
 * - If no CLAUDE.md exists, generates one.
 * - If a generated CLAUDE.md exists (has our marker), updates it.
 * - If a user-managed CLAUDE.md exists, leaves it untouched.
 * - Non-fatal: logs and continues on any error.
 */
export async function ensureAcpWorkspaceContext(
  workspaceDir: string,
  options?: AcpWorkspaceContextOptions,
): Promise<void> {
  try {
    const claudeMdPath = path.join(workspaceDir, "CLAUDE.md");
    const exists = await fileExists(claudeMdPath);

    if (exists) {
      const isGenerated = await isGeneratedClaudeMd(claudeMdPath);
      if (!isGenerated) {
        // User-managed CLAUDE.md — don't touch
        log.debug("workspace has user-managed CLAUDE.md, skipping", { workspaceDir });
        return;
      }
      // Update our generated version
    }

    const content = buildClaudeMdContent(options);
    await fs.writeFile(claudeMdPath, content, "utf-8");
    log.debug(exists ? "updated generated CLAUDE.md" : "created CLAUDE.md", { workspaceDir });
  } catch (err) {
    // Non-fatal — workspace context is a best-effort enhancement
    log.warn("failed to ensure workspace CLAUDE.md", { workspaceDir, error: err });
  }
}

// ---------------------------------------------------------------------------
// MCP session context file
// ---------------------------------------------------------------------------

export type AcpSessionContextParams = {
  sessionKey: string;
  agentId: string;
  accountId: string;
  gatewayUrl?: string;
  gatewayToken?: string;
};

/**
 * Writes MCP session context to the workspace so the unified OpenClaw MCP server
 * can discover per-session identity when started as an ACPX stdio subprocess.
 *
 * The file is written to `<workspaceDir>/.openclaw/mcp-session-context.json`.
 * The MCP server reads it as a fallback when env vars are not set.
 *
 * Non-fatal: logs and continues on any error.
 */
export async function writeAcpSessionContext(
  workspaceDir: string,
  params: AcpSessionContextParams,
): Promise<void> {
  try {
    const contextDir = path.join(workspaceDir, path.dirname(MCP_SESSION_CONTEXT_FILENAME));
    await fs.mkdir(contextDir, { recursive: true });
    const filePath = path.join(workspaceDir, MCP_SESSION_CONTEXT_FILENAME);
    const data = {
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      accountId: params.accountId,
      ...(params.gatewayUrl ? { gatewayUrl: params.gatewayUrl } : {}),
      ...(params.gatewayToken ? { gatewayToken: params.gatewayToken } : {}),
    };
    await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    log.debug("wrote MCP session context", { workspaceDir, sessionKey: params.sessionKey });
  } catch (err) {
    log.warn("failed to write MCP session context", { workspaceDir, error: err });
  }
}

/**
 * Removes the MCP session context file from the workspace.
 * Called during session cleanup.
 *
 * Non-fatal: logs and continues on any error.
 */
export async function removeAcpSessionContext(workspaceDir: string): Promise<void> {
  try {
    const filePath = path.join(workspaceDir, MCP_SESSION_CONTEXT_FILENAME);
    await fs.unlink(filePath);
    log.debug("removed MCP session context", { workspaceDir });
  } catch {
    // File may not exist — that's fine
  }
}
