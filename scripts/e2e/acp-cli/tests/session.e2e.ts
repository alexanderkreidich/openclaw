import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createNativeCliHarness,
  destroyNativeCliHarness,
  runNativeAgentTurn,
  runNativeSessionsList,
  seedNativeCliSession,
  startNativeCliGateway,
  waitForOpenClawTranscriptSnapshot,
  type NativeCliHarness,
} from "../lib/native-cli-live-harness.js";

const LIVE = process.env.LIVE === "1";
const describeLive = LIVE ? describe : describe.skip;
const TEST_TIMEOUT_MS = 240_000;
const HISTORY_SESSION_KEY = "agent:claude:launch-yesterday";

function createClaudeWorkspaceFiles() {
  return {
    "AGENTS.md": "# Claude\n\nFollow the generated CLAUDE.md rules exactly.\n",
    "SOUL.md": "You are precise and concise.\n",
    "IDENTITY.md": "name: Claude\nemoji: 🦞\n",
    "USER.md": "The user expects exact tool usage when session history is needed.\n",
    "TOOLS.md":
      "Use openclaw_read_history before answering questions about decisions from another session.\n",
    "MEMORY.md": `Launch discussion recap lives in session key ${HISTORY_SESSION_KEY}. If asked what we decided yesterday about the launch, first call openclaw_read_history with that exact session key.\n`,
    "BOOTSTRAP.md":
      "Do not close a session for normal follow-up editing. If the user says they are all done, close the session.\n",
    "HEARTBEAT.md": "If no action is needed, answer HEARTBEAT_OK only.\n",
  };
}

function createCalendarWorkspaceFiles() {
  return {
    "AGENTS.md":
      "# Calendar Only\n\nYou only handle calendar and scheduling work. For off-topic requests, call openclaw_session_close with a short handoff message to a general assistant.\n",
    "SOUL.md": "You are narrow, direct, and scheduling-focused.\n",
    "IDENTITY.md": "name: Calendar Only\nemoji: 📅\n",
    "USER.md": "The user expects you to stay in scope.\n",
    "TOOLS.md":
      "If the request is not about calendar, time, availability, or scheduling, hand off and close the session.\n",
    "MEMORY.md": "No extra memories for this agent.\n",
    "BOOTSTRAP.md": "Out-of-scope technical debugging must be handed off.\n",
    "HEARTBEAT.md": "If no action is needed, answer HEARTBEAT_OK only.\n",
  };
}

function findToolCall(
  turn: { toolCalls: Array<{ name: string; args: Record<string, unknown> }> },
  toolName: string,
) {
  return turn.toolCalls.find((call) => call.name === toolName);
}

describeLive("ACP CLI native E2E: Track F session lifecycle", () => {
  let harness: NativeCliHarness;

  beforeAll(async () => {
    harness = await createNativeCliHarness({
      trackName: "track-f",
      agentId: "claude",
      agents: [
        {
          id: "claude",
          name: "Claude",
          workspaceFiles: createClaudeWorkspaceFiles(),
        },
        {
          id: "calendar-only",
          name: "Calendar Only",
          workspaceFiles: createCalendarWorkspaceFiles(),
        },
      ],
    });
    await startNativeCliGateway(harness);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await destroyNativeCliHarness(harness);
  }, TEST_TIMEOUT_MS);

  it(
    "covers mid-task follow-up, explicit completion, off-topic close, history recall, and post-close session listing",
    async () => {
      await seedNativeCliSession({ harness, agentId: "claude", sessionId: "sess-1" });

      await runNativeAgentTurn({
        harness,
        agentId: "claude",
        sessionId: "sess-1",
        message: "Help me draft an email.",
      });
      const firstTurn = await waitForOpenClawTranscriptSnapshot(
        harness,
        { agentId: "claude", sessionId: "sess-1" },
        (snapshot) => snapshot.assistantText.trim().length > 0,
      );
      expect(findToolCall(firstTurn, "openclaw_session_close")).toBeUndefined();

      await runNativeAgentTurn({
        harness,
        agentId: "claude",
        sessionId: "sess-1",
        message: "Actually, make it more formal.",
      });
      const secondTurn = await waitForOpenClawTranscriptSnapshot(
        harness,
        { agentId: "claude", sessionId: "sess-1" },
        (snapshot) => snapshot.messages.length > firstTurn.messages.length,
      );
      expect(findToolCall(secondTurn, "openclaw_session_close")).toBeUndefined();

      await runNativeAgentTurn({
        harness,
        agentId: "claude",
        sessionId: "sess-1",
        message: "Thanks, that's perfect. All done.",
      });
      const finalTurn = await waitForOpenClawTranscriptSnapshot(
        harness,
        { agentId: "claude", sessionId: "sess-1" },
        (snapshot) => snapshot.toolCalls.some((call) => call.name === "openclaw_session_close"),
      );
      expect(findToolCall(finalTurn, "openclaw_session_close")).toBeDefined();

      await seedNativeCliSession({ harness, agentId: "calendar-only", sessionId: "sess-2" });
      await runNativeAgentTurn({
        harness,
        agentId: "calendar-only",
        sessionId: "sess-2",
        message: "Help me debug my Python code",
      });
      const handoffTurn = await waitForOpenClawTranscriptSnapshot(
        harness,
        { agentId: "calendar-only", sessionId: "sess-2" },
        (snapshot) => snapshot.toolCalls.some((call) => call.name === "openclaw_session_close"),
      );
      const closeCall = findToolCall(handoffTurn, "openclaw_session_close");
      expect(closeCall).toBeDefined();
      const closeMessage = closeCall?.args.message;
      expect(typeof closeMessage === "string" ? closeMessage : "").toMatch(
        /(general assistant|coding agent|better handled)/i,
      );

      await seedNativeCliSession({
        harness,
        agentId: "claude",
        sessionId: "launch-yesterday",
        sessionKey: HISTORY_SESSION_KEY,
        messages: [
          { role: "user", text: "What should we do for the launch?" },
          {
            role: "assistant",
            text: "We decided to launch on Thursday, keep pricing unchanged, and post the announcement at 10 AM.",
          },
        ],
      });
      await seedNativeCliSession({ harness, agentId: "claude", sessionId: "sess-3" });
      await runNativeAgentTurn({
        harness,
        agentId: "claude",
        sessionId: "sess-3",
        message: "What did we decide yesterday about the launch?",
      });
      const historyTurn = await waitForOpenClawTranscriptSnapshot(
        harness,
        { agentId: "claude", sessionId: "sess-3" },
        (snapshot) => snapshot.toolCalls.some((call) => call.name === "openclaw_read_history"),
      );
      const historyCall = findToolCall(historyTurn, "openclaw_read_history");
      expect(historyCall).toBeDefined();
      expect(historyCall?.args.session_key).toBe(HISTORY_SESSION_KEY);

      const claudeSessions = await runNativeSessionsList({ harness, agentId: "claude" });
      const calendarSessions = await runNativeSessionsList({
        harness,
        agentId: "calendar-only",
      });
      expect(claudeSessions.sessions?.some((session) => session.sessionId === "sess-1")).toBe(
        false,
      );
      expect(calendarSessions.sessions?.some((session) => session.sessionId === "sess-2")).toBe(
        false,
      );
    },
    TEST_TIMEOUT_MS,
  );
});
