import { describe, expect, it } from "vitest";
import { runEval } from "./harness.js";
import { assertRules, calledInOrder, mustCallTool, readBootstrapFiles } from "./rules.js";

describe("ACP eval harness", () => {
  it("produces a deterministic mock transcript for track 0", async () => {
    const transcript = await runEval({
      prompt: "Send a short acknowledgement.",
      sessionSeed: "track-0-mock",
      mode: "mock",
      finalReplyText: "Acknowledged.",
    });

    assertRules(transcript, [
      readBootstrapFiles(),
      mustCallTool("openclaw_send"),
      calledInOrder("Read", "Read", "Read", "Read", "Read", "openclaw_send"),
    ]);

    expect(transcript.replyText).toBe("Acknowledged.");
    expect(transcript.filesWritten).toEqual([]);
  });
});
