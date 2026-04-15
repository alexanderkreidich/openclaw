# Research: Claude Code Agent System, MCP, and ACP Integration

**Researched:** 2026-04-13
**Overall confidence:** HIGH (primary sources are official Claude Code docs and MCP SDK docs)

---

## 1. Claude Code Subagent System

### How It Works

Claude Code's agent system is built around **subagents** -- specialized AI assistants that run in their own context window with custom system prompts, tool restrictions, and independent permissions. Subagents are the primary extensibility mechanism.

**Key properties:**

- Each subagent gets its own context window (separate from main conversation)
- Subagents CANNOT spawn other subagents (no nesting)
- Results return as summaries to the parent conversation
- Background subagents can run concurrently

### Subagent Definition Format

Subagents are Markdown files with YAML frontmatter stored at:

| Location                     | Scope                   | Priority    |
| ---------------------------- | ----------------------- | ----------- |
| Managed settings             | Organization-wide       | 1 (highest) |
| `--agents` CLI flag (JSON)   | Current session         | 2           |
| `.claude/agents/`            | Current project         | 3           |
| `~/.claude/agents/`          | All user projects       | 4           |
| Plugin's `agents/` directory | Where plugin is enabled | 5 (lowest)  |

**File format:**

```markdown
---
name: my-agent
description: When Claude should delegate to this agent
tools: Read, Grep, Glob, Bash
model: sonnet
permissionMode: default
maxTurns: 50
memory: project
background: false
effort: medium
isolation: worktree
color: blue
skills:
  - api-conventions
mcpServers:
  - playwright:
      type: stdio
      command: npx
      args: ["-y", "@playwright/mcp@latest"]
  - github
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate.sh"
---

You are a specialist. Your system prompt goes here in the markdown body.
```

### Supported Frontmatter Fields

| Field             | Required | Description                                                              |
| ----------------- | -------- | ------------------------------------------------------------------------ |
| `name`            | Yes      | Unique ID, lowercase + hyphens                                           |
| `description`     | Yes      | When to delegate to this agent                                           |
| `tools`           | No       | Allowlist; inherits all if omitted                                       |
| `disallowedTools` | No       | Denylist, removed from inherited set                                     |
| `model`           | No       | `sonnet`, `opus`, `haiku`, full model ID, or `inherit`                   |
| `permissionMode`  | No       | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan` |
| `maxTurns`        | No       | Max agentic turns                                                        |
| `skills`          | No       | Skills to inject at startup                                              |
| `mcpServers`      | No       | MCP servers (inline def or string reference)                             |
| `hooks`           | No       | Lifecycle hooks scoped to agent                                          |
| `memory`          | No       | `user`, `project`, or `local` for persistent memory                      |
| `background`      | No       | Always run as background task                                            |
| `effort`          | No       | `low`, `medium`, `high`, `max`                                           |
| `isolation`       | No       | `worktree` for isolated git worktree                                     |
| `color`           | No       | Display color                                                            |
| `initialPrompt`   | No       | Auto-submitted first user turn when run as main agent                    |

### Invocation Patterns

1. **Automatic delegation** -- Claude matches task to agent `description`
2. **@-mention** -- `@"my-agent (agent)"` guarantees invocation
3. **Session-wide** -- `claude --agent my-agent` replaces default system prompt
4. **CLI JSON** -- `claude --agents '{ "name": { ... } }'` for ephemeral agents
5. **Setting** -- `{ "agent": "my-agent" }` in `.claude/settings.json`

### Agent Tool Restrictions

- `Agent(worker, researcher)` in `tools` restricts which subagent types can be spawned
- `Agent` without parens allows spawning any subagent
- Omitting `Agent` entirely prevents spawning subagents
- Plugin subagents cannot use `hooks`, `mcpServers`, or `permissionMode` (security)

### Built-in Subagents

| Agent           | Model     | Purpose                            |
| --------------- | --------- | ---------------------------------- |
| Explore         | Haiku     | Read-only codebase search/analysis |
| Plan            | Inherited | Research during plan mode          |
| General-purpose | Inherited | Complex multi-step tasks           |

### System Prompt Assembly

Claude Code's system prompt is dynamically assembled from 30+ conditional sections:

**Always included:** Intro, System Rules, Doing Tasks, Executing Actions, Tone/Style

**Conditionally included:**

- Cache boundary markers
- Session guidance (Ask User, Shell Shortcut, Agent Tool, Skills)
- Verification Agent instructions
- Memory system prompts
- Environment info (OS, shell, CWD)
- Language preferences
- MCP server instructions
- Token budget guidance

**Key insight for integration:** When using `--agent`, the agent's markdown body **replaces** the default Claude Code system prompt entirely. However, `CLAUDE.md` files and project memory still load through the normal user message flow. This means CLAUDE.md/AGENTS.md content is injected as user-role messages, not system prompt content.

**Source:** [How Claude Code Builds a System Prompt](https://www.dbreunig.com/2026/04/04/how-claude-code-builds-a-system-prompt.html) -- HIGH confidence

---

## 2. Model Context Protocol (MCP)

### Protocol Specification

MCP is a JSON-RPC 2.0 based protocol (similar to LSP) for connecting AI applications to external tools and data. Current spec: 2025-11-25. Governed by the Agentic AI Foundation (Linux Foundation).

**Three primitives:**

1. **Tools** -- Invokable actions (model-controlled)
2. **Resources** -- Read-only data (application-controlled)
3. **Prompts** -- Reusable interaction templates (user-controlled)

### Transport Types

| Transport           | Use Case                     | How It Works               |
| ------------------- | ---------------------------- | -------------------------- |
| **stdio**           | Local processes              | JSON-RPC over stdin/stdout |
| **Streamable HTTP** | Remote servers (recommended) | HTTP + SSE streaming       |
| **SSE**             | Remote servers (deprecated)  | Server-Sent Events         |

### TypeScript SDK Implementation

**Package:** `@modelcontextprotocol/sdk` (97M+ monthly downloads)

**Minimal server:**

```typescript
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";

const server = new McpServer(
  { name: "my-server", version: "1.0.0" },
  { instructions: "How to use this server" },
);

// Register a tool
server.registerTool(
  "my-tool",
  {
    title: "My Tool",
    description: "Does something useful",
    inputSchema: z.object({
      query: z.string(),
    }),
  },
  async ({ query }) => ({
    content: [{ type: "text", text: `Result for: ${query}` }],
  }),
);

// Register a resource
server.registerResource(
  "config",
  "config://app",
  { title: "App Config", mimeType: "application/json" },
  async (uri) => ({
    contents: [{ uri: uri.href, text: JSON.stringify({ key: "value" }) }],
  }),
);

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
```

**Tool annotations** hint at behavior:

```typescript
annotations: {
  destructiveHint: true,   // modifies state
  idempotentHint: true,    // safe to retry
  readOnlyHint: false,     // does NOT just read
}
```

**Error handling:** Return `isError: true` for tool-level errors the LLM should see.

**Resource links:** Reference large resources without embedding content inline.

**Source:** [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) -- HIGH confidence

### Claude Code MCP Integration

**Adding servers:**

```bash
# Remote HTTP (recommended)
claude mcp add --transport http <name> <url>

# Remote SSE (deprecated)
claude mcp add --transport sse <name> <url>

# Local stdio
claude mcp add --transport stdio <name> -- <command> [args...]
```

**Configuration scopes:**

| Scope           | Stored In                    | Shared?   |
| --------------- | ---------------------------- | --------- |
| Local (default) | `~/.claude.json` per-project | No        |
| Project         | `.mcp.json` in project root  | Yes (VCS) |
| User            | `~/.claude.json` global      | No        |

**`.mcp.json` format (project-shared):**

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["./my-server.js"],
      "env": {
        "API_KEY": "${API_KEY}"
      }
    }
  }
}
```

Supports `${VAR}` and `${VAR:-default}` environment variable expansion in `command`, `args`, `env`, `url`, `headers`.

**Tool Search (Lazy Loading):** Claude Code uses on-demand tool discovery. Instead of loading every tool definition upfront, it searches for relevant tools per task. This reduces context consumption by 85-95%.

**Dynamic updates:** MCP `list_changed` notifications let servers update available tools without reconnect.

**Channels:** MCP servers can push messages into sessions via `claude/channel` capability.

**Source:** [Claude Code MCP Docs](https://code.claude.com/docs/en/mcp) -- HIGH confidence

### Plugin-Bundled MCP Servers

Plugins can bundle MCP servers that start automatically when the plugin is enabled:

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/my-server",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
      "env": { "DB_URL": "${DB_URL}" }
    }
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` resolves to the plugin directory. `${CLAUDE_PLUGIN_DATA}` for persistent state.

---

## 3. Agent Client Protocol (ACP)

### What ACP Is

ACP (Agent Client Protocol) standardizes how agents and client programs interact. Introduced September 2025, it enables editors/tools to support any ACP-compatible agent without custom integrations.

**Key distinction from MCP:**

- **MCP** = connecting AI to tools/data (tool-level protocol)
- **ACP** = connecting AI agents to client applications (agent-level protocol)

### OpenClaw's ACP Integration

OpenClaw already has ACP support via the `acpx` bundled plugin. This is the most relevant reference for integration patterns.

**Architecture:**

```
OpenClaw ACP session control plane
  -> bundled `acpx` runtime plugin
    -> Claude ACP adapter (or Codex, Copilot, etc.)
      -> Agent-side runtime
```

**Configuration:**

```json5
{
  acp: {
    enabled: true,
    backend: "acpx",
    defaultAgent: "codex",
    allowedAgents: ["claude", "codex", "copilot", "cursor", ...],
    maxConcurrentSessions: 8
  }
}
```

**Spawning sessions:**

```json
{
  "task": "Fix failing tests",
  "runtime": "acp",
  "agentId": "codex",
  "thread": true,
  "mode": "session"
}
```

**Session binding models:**

- `--bind here` -- Route to current conversation
- Thread-bound -- Auto-create thread (Discord/Telegram)

**Session resumption** via `resumeSessionId` with full context replay.

**Permission handling** (non-interactive):

- `approve-all` -- Auto-approve everything
- `approve-reads` -- Auto-approve reads only (default)
- `deny-all` -- Deny all prompts

**Supported harnesses:** claude, codex, copilot, cursor, droid, gemini, iflow, kilocode, kimi, kiro, openclaw, opencode, pi, qwen

**Source:** [OpenClaw ACP Agents docs](https://docs.openclaw.ai/tools/acp-agents) -- HIGH confidence

### ACP vs Claude Code's Native Agent System

| Aspect      | Claude Code Subagents         | ACP Sessions                    |
| ----------- | ----------------------------- | ------------------------------- |
| Runtime     | Inside Claude Code process    | External agent process          |
| Protocol    | Internal tool invocation      | ACP wire protocol               |
| Context     | Shares parent session context | Independent runtime             |
| Nesting     | Cannot nest subagents         | Can orchestrate multiple agents |
| Persistence | Session-scoped (with resume)  | Durable sessions with replay    |
| Tool access | Claude Code's tools           | Agent's own tools               |

---

## 4. Claude Code Hooks System

### Lifecycle Events

Claude Code exposes lifecycle hooks for automation. As of April 2026, there are 12+ events with 4 handler types.

**Core events:**

| Event           | When                    | Can Block?   |
| --------------- | ----------------------- | ------------ |
| `PreToolUse`    | Before any tool call    | Yes (exit 2) |
| `PostToolUse`   | After tool completes    | No           |
| `SubagentStart` | When subagent begins    | No           |
| `SubagentStop`  | When subagent completes | No           |
| `Stop`          | When agent finishes     | No           |

**Handler types:**

1. `command` -- Shell command
2. `prompt` -- LLM-based semantic evaluation
3. `agent` -- Deep codebase analysis

**Hook input (PreToolUse):** JSON on stdin with `tool_input` (arguments being passed to the tool).

**Hook input (PostToolUse):** JSON on stdin with `tool_input` AND `tool_response`.

**Configuration locations:**

- Subagent frontmatter `hooks:` field
- `settings.json` for project-level hooks

**Source:** [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- HIGH confidence

---

## 5. Integration Patterns for OpenClaw

### Pattern A: OpenClaw as MCP Server for Claude Code

Expose OpenClaw functionality as MCP tools that Claude Code can discover and use.

**Implementation:**

1. Build MCP server using `@modelcontextprotocol/sdk`
2. Register OpenClaw capabilities as tools (send messages, manage channels, etc.)
3. Users add via `claude mcp add` or `.mcp.json`

**Example:**

```typescript
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";

const server = new McpServer(
  { name: "openclaw", version: "1.0.0" },
  { instructions: "OpenClaw messaging tools for managing channels and agents" },
);

server.registerTool(
  "send-message",
  {
    title: "Send Message",
    description: "Send a message through an OpenClaw channel",
    inputSchema: z.object({
      channel: z.string(),
      peer: z.string(),
      message: z.string(),
    }),
  },
  async ({ channel, peer, message }) => {
    // Call OpenClaw API
    const result = await openclawSend(channel, peer, message);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Pattern B: Claude Code Subagents Defined by OpenClaw Plugin

Ship subagent definitions in OpenClaw's Claude Code plugin `agents/` directory.

**Constraints:** Plugin subagents cannot use `hooks`, `mcpServers`, or `permissionMode`. Users must copy to `.claude/agents/` for those features.

### Pattern C: OpenClaw as ACP Host (Already Exists)

OpenClaw already runs Claude Code as an ACP session. The `acpx` plugin handles:

- Session lifecycle (spawn, resume, close)
- Conversation binding (current chat or thread)
- Permission management
- Multi-harness support

### Pattern D: Workspace Context Injection via CLAUDE.md

Ship a `CLAUDE.md` in the OpenClaw repo root with project-specific instructions. This gets injected into every Claude Code session working in the repo as user-role messages.

**Key facts:**

- `CLAUDE.md` at repo root: always loaded
- `.claude/agents/` for project subagents: loaded at session start
- `AGENTS.md` files: scoped to nearest directory (closest to edited file takes precedence)
- When `--agent` is used, agent body replaces system prompt but CLAUDE.md still loads

---

## 6. Claude Managed Agents API (Beta)

As of April 2026, Anthropic offers a **Managed Agents API** for running Claude as an autonomous agent in the cloud.

**Key details:**

- Beta header required: `managed-agents-2026-04-01`
- Provides sandboxed code execution, checkpointing, credential management
- Separate from Claude Code's local agent system
- Uses the Claude Agent SDK (TypeScript/Python)

**Agent SDK system prompt customization:**

```typescript
// Use Claude Code's preset prompt
systemPrompt: { type: "preset", preset: "claude_code" }

// Append to preset
systemPrompt: {
  type: "preset",
  preset: "claude_code",
  append: "Additional instructions here"
}

// Fully custom
systemPrompt: { type: "custom", text: "Your full system prompt" }
```

**Source:** [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) -- MEDIUM confidence (beta, may change)

---

## 7. Confidence Assessment

| Area                               | Confidence | Source                            |
| ---------------------------------- | ---------- | --------------------------------- |
| Claude Code subagent system        | HIGH       | Official docs (code.claude.com)   |
| MCP server implementation          | HIGH       | Official SDK + docs               |
| MCP Claude Code integration        | HIGH       | Official docs                     |
| ACP protocol details               | HIGH       | OpenClaw's own docs + community   |
| Claude Code system prompt assembly | HIGH       | Verified analysis + official docs |
| Hooks system                       | HIGH       | Official docs                     |
| Managed Agents API                 | MEDIUM     | Beta API, subject to change       |

---

## 8. Key Takeaways

1. **For exposing OpenClaw to Claude Code:** Build an MCP server. This is the standard, well-supported path. Use `@modelcontextprotocol/sdk` with stdio transport for local use or Streamable HTTP for remote.

2. **For running Claude Code from OpenClaw:** ACP is already implemented via `acpx`. The existing architecture is solid.

3. **For project-specific agent behavior:** Ship `.claude/agents/` Markdown files and `CLAUDE.md` in the repo. These are the standard workspace context injection points.

4. **For programmatic Claude Code:** Use `claude -p "prompt" --output-format json` for scripted single-shot usage, or the Claude Agent SDK for managed agent sessions.

5. **MCP Tool Search is key:** Claude Code lazy-loads tools, so having many tools in an MCP server is fine -- only relevant ones get loaded per task.

6. **No ACP standard spec yet:** ACP is more of a community convention than a formal spec. OpenClaw's `acpx` implementation is one of the more mature reference implementations.

---

## Sources

- [Create custom subagents - Claude Code Docs](https://code.claude.com/docs/en/sub-agents)
- [Connect Claude Code to tools via MCP - Claude Code Docs](https://code.claude.com/docs/en/mcp)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [How Claude Code Builds a System Prompt](https://www.dbreunig.com/2026/04/04/how-claude-code-builds-a-system-prompt.html)
- [Claude Code System Prompts (leaked/documented)](https://github.com/Piebald-AI/claude-code-system-prompts)
- [OpenClaw ACP Agents](https://docs.openclaw.ai/tools/acp-agents)
- [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference)
- [ACP for Claude Code (community)](https://github.com/Xuanwo/acp-claude-code)
- [MCP 2026 Roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
