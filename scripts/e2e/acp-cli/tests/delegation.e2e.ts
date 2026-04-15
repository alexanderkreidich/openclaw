import assert from "node:assert/strict";
import {
  createNativeCliHarness,
  destroyNativeCliHarness,
  getToolCallsByName,
  readGatewayLogTail,
  runNativeAgentTurn,
  startNativeCliGateway,
  waitForClaudeSessionSnapshot,
  type ClaudeToolCall,
} from "../lib/native-cli-live-harness.js";

function createDelegationWorkspaceFiles() {
  return {
    "AGENTS.md": "# Claude\n\nFollow the generated CLAUDE.md rules exactly.\n",
    "SOUL.md": "You are concise, delegation-first, and avoid noisy polling.\n",
    "IDENTITY.md": "name: Claude\nemoji: 🦞\n",
    "USER.md": "The user expects OpenClaw-native delegation through MCP tools.\n",
    "TOOLS.md":
      "For complex research and explicit Claude Code requests, use openclaw_spawn_agent. Do not use openclaw_agents_list for polling or ACP harness discovery.\n",
    "MEMORY.md": "No extra memory is needed for Track D.\n",
    "BOOTSTRAP.md":
      "After spawning a delegated session, wait for push-based completion instead of polling in a loop.\n",
    "HEARTBEAT.md": "If no action is needed, answer HEARTBEAT_OK only.\n",
  };
}

function lowercasedTask(call: ClaudeToolCall): string {
  const args = call.args as { task?: unknown };
  return typeof args?.task === "string" ? args.task.toLowerCase() : "";
}

function matchesToolName(actualName: string, expectedName: string): boolean {
  return actualName === expectedName || actualName.endsWith(`__${expectedName}`);
}

function isAcpSpawnResult(call: ClaudeToolCall): boolean {
  if (matchesToolName(call.name, "sessions_spawn")) {
    const args = call.args as { runtime?: unknown };
    return args?.runtime === "acp";
  }
  if (
    !matchesToolName(call.name, "openclaw_spawn_agent") ||
    !call.result ||
    typeof call.result !== "object"
  ) {
    return false;
  }
  const result = call.result as { childSessionKey?: unknown };
  return typeof result.childSessionKey === "string" && result.childSessionKey.includes(":acp:");
}

async function main(): Promise<void> {
  if (process.env.LIVE !== "1") {
    process.stdout.write("skipped: LIVE=1 not set\n");
    return;
  }

  const harness = await createNativeCliHarness({
    trackName: "delegation",
    agentId: "claude",
    agents: [
      {
        id: "claude",
        name: "Claude",
        workspaceFiles: createDelegationWorkspaceFiles(),
      },
    ],
  });

  try {
    await startNativeCliGateway(harness);

    await runNativeAgentTurn({
      harness,
      sessionId: "del-1",
      message: "Research the top 5 LLM pricing changes this quarter and summarize.",
    });
    const del1 = await waitForClaudeSessionSnapshot(harness, "del-1", (snapshot) =>
      getToolCallsByName(snapshot, "openclaw_spawn_agent").some((call) =>
        lowercasedTask(call).includes("research"),
      ),
    );
    assert.ok(
      getToolCallsByName(del1, "openclaw_spawn_agent").some((call) =>
        lowercasedTask(call).includes("research"),
      ),
      "del-1 should call openclaw_spawn_agent with a research task",
    );

    await runNativeAgentTurn({
      harness,
      sessionId: "del-2",
      message: "What's 2+2?",
    });
    const del2 = await waitForClaudeSessionSnapshot(
      harness,
      "del-2",
      (snapshot) => snapshot.messages.length > 0,
    );
    assert.equal(
      getToolCallsByName(del2, "openclaw_spawn_agent").length,
      0,
      "del-2 must not call openclaw_spawn_agent",
    );

    await runNativeAgentTurn({
      harness,
      sessionId: "del-3",
      message: "Do this in Claude Code: refactor my TypeScript config",
    });
    const del3 = await waitForClaudeSessionSnapshot(harness, "del-3", (snapshot) =>
      snapshot.toolCalls.some(isAcpSpawnResult),
    );
    assert.ok(
      del3.toolCalls.some(isAcpSpawnResult),
      "del-3 must delegate through runtime='acp' evidence",
    );

    await runNativeAgentTurn({
      harness,
      sessionId: "del-1",
      message: "any update?",
    });
    const del1Followup = await waitForClaudeSessionSnapshot(
      harness,
      "del-1",
      (snapshot) => snapshot.messages.length > del1.messages.length,
    );
    assert.ok(
      getToolCallsByName(del1Followup, "openclaw_agents_list").length <= 1,
      "del-1 follow-up must not poll openclaw_agents_list in a loop",
    );

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          del1SpawnCalls: getToolCallsByName(del1Followup, "openclaw_spawn_agent").length,
          del2SpawnCalls: getToolCallsByName(del2, "openclaw_spawn_agent").length,
          del3AcpDelegation: del3.toolCalls.some(isAcpSpawnResult),
          del1AgentsListCalls: getToolCallsByName(del1Followup, "openclaw_agents_list").length,
        },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n\n${await readGatewayLogTail(harness.gatewayLogPath)}\n`);
    process.exitCode = 1;
  } finally {
    await destroyNativeCliHarness(harness);
  }
}

void main();
