import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createNativeCliHarness,
  destroyNativeCliHarness,
  runNativeAgentTurn,
  seedNativeCliSession,
  startNativeCliGateway,
  waitForOpenClawTranscriptSnapshot,
  type NativeCliHarness,
} from "../lib/native-cli-live-harness.js";

const LIVE = process.env.LIVE === "1";
const describeLive = LIVE ? describe : describe.skip;
const TEST_TIMEOUT_MS = 240_000;

function createCommonWorkspaceFiles(agentLabel: string) {
  return {
    "AGENTS.md": `# ${agentLabel}\n\nFollow the generated CLAUDE.md rules exactly.\n`,
    "SOUL.md": "You are precise, quiet, and tool-using.\n",
    "IDENTITY.md": `name: ${agentLabel}\nemoji: 🦞\n`,
    "USER.md": "The user values exact tokens and concise replies.\n",
    "TOOLS.md":
      "Use OpenClaw MCP tools when they directly match the request. Image requests must use openclaw_image_generate. Voice-note requests must use openclaw_tts.\n",
    "MEMORY.md": "No long-term memories are needed for this track.\n",
    "BOOTSTRAP.md":
      "When a message is an internal scheduled follow-up with no user-visible content, answer with NO_REPLY only.\n",
    "HEARTBEAT.md": "If no action is needed, answer HEARTBEAT_OK only.\n",
  };
}

function expectToolCall(turn: { toolCalls: Array<{ name: string }> }, toolName: string) {
  expect(turn.toolCalls.some((call) => call.name === toolName)).toBe(true);
}

describeLive("ACP CLI native E2E: Track E directives", () => {
  let harness: NativeCliHarness;

  beforeAll(async () => {
    harness = await createNativeCliHarness({
      trackName: "track-e",
      agentId: "claude",
      agents: [
        {
          id: "claude",
          name: "Claude",
          workspaceFiles: createCommonWorkspaceFiles("Claude"),
        },
        {
          id: "calendar-only",
          name: "Calendar Only",
          workspaceFiles: createCommonWorkspaceFiles("Calendar Only"),
        },
      ],
    });
    await startNativeCliGateway(harness);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await destroyNativeCliHarness(harness);
  }, TEST_TIMEOUT_MS);

  it(
    "returns exact NO_REPLY for silent internal scheduled work",
    async () => {
      await seedNativeCliSession({ harness, agentId: "claude", sessionId: "dir-1" });
      await runNativeAgentTurn({
        harness,
        agentId: "claude",
        sessionId: "dir-1",
        message: "[internal scheduled followup, no user message]",
      });
      const turn = await waitForOpenClawTranscriptSnapshot(
        harness,
        { agentId: "claude", sessionId: "dir-1" },
        (snapshot) => snapshot.assistantText.trim().length > 0,
      );

      expect(turn.assistantText.trim()).toMatch(/^no_reply$/i);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "puts [[reply_to_current]] first when thread reply context is present",
    async () => {
      await seedNativeCliSession({ harness, agentId: "claude", sessionId: "dir-2" });
      await runNativeAgentTurn({
        harness,
        agentId: "claude",
        sessionId: "dir-2",
        message: "Actually, can you clarify step 3?",
        extraArgs: ["--channel", "discord", "--thread-parent", "msg-123"],
      });
      const turn = await waitForOpenClawTranscriptSnapshot(
        harness,
        { agentId: "claude", sessionId: "dir-2" },
        (snapshot) => snapshot.assistantText.trim().length > 0,
      );

      expect(turn.assistantText.trim().startsWith("[[reply_to_current]]")).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "uses the image tool and returns a MEDIA line for image generation",
    async () => {
      await seedNativeCliSession({ harness, agentId: "claude", sessionId: "dir-3" });
      await runNativeAgentTurn({
        harness,
        agentId: "claude",
        sessionId: "dir-3",
        message: "Generate an image of a lobster.",
      });
      const turn = await waitForOpenClawTranscriptSnapshot(
        harness,
        { agentId: "claude", sessionId: "dir-3" },
        (snapshot) => snapshot.toolCalls.some((call) => call.name === "openclaw_image_generate"),
      );

      expectToolCall(turn, "openclaw_image_generate");
      expect(turn.assistantText).toMatch(/(?:^|\n)MEDIA:[^\n]+\.(png|webp)(?:\s|$)/i);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "uses TTS for voice notes and returns the audio delivery directives",
    async () => {
      await seedNativeCliSession({ harness, agentId: "claude", sessionId: "dir-4" });
      await runNativeAgentTurn({
        harness,
        agentId: "claude",
        sessionId: "dir-4",
        message: "Send this as a voice note: 'good morning'",
      });
      const turn = await waitForOpenClawTranscriptSnapshot(
        harness,
        { agentId: "claude", sessionId: "dir-4" },
        (snapshot) => snapshot.toolCalls.some((call) => call.name === "openclaw_tts"),
      );

      expectToolCall(turn, "openclaw_tts");
      expect(turn.assistantText).toContain("[[audio_as_voice]]");
      expect(turn.assistantText).toMatch(/(?:^|\n)MEDIA:[^\n]+\.(mp3|wav|ogg|m4a)(?:\s|$)/i);
    },
    TEST_TIMEOUT_MS,
  );
});
