import fs from "node:fs/promises";

function parseArgs(argv) {
  const parsed = {
    mode: process.env.LIVE === "1" ? "live" : "mock",
    prompt: "Read your bootstrap files, then send a short acknowledgement.",
    sessionSeed: "track-0",
    scriptedPath: undefined,
    finalReplyText: undefined,
    serveMcp: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "serve-mcp") {
      parsed.serveMcp = true;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      parsed.mode = arg.slice("--mode=".length);
      continue;
    }
    if (arg === "--mode") {
      parsed.mode = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--prompt=")) {
      parsed.prompt = arg.slice("--prompt=".length);
      continue;
    }
    if (arg === "--prompt") {
      parsed.prompt = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--session-seed=")) {
      parsed.sessionSeed = arg.slice("--session-seed=".length);
      continue;
    }
    if (arg === "--session-seed") {
      parsed.sessionSeed = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--scripted=")) {
      parsed.scriptedPath = arg.slice("--scripted=".length);
      continue;
    }
    if (arg === "--scripted") {
      parsed.scriptedPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--final-reply=")) {
      parsed.finalReplyText = arg.slice("--final-reply=".length);
      continue;
    }
    if (arg === "--final-reply") {
      parsed.finalReplyText = argv[index + 1];
      index += 1;
      continue;
    }
  }

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const harness = await import(new URL("../src/acp/eval/harness.ts", import.meta.url));

  if (args.serveMcp) {
    await harness.serveEvalMcpServerFromEnv();
    return;
  }

  if (args.mode === "live" && process.env.LIVE !== "1") {
    process.stdout.write("skipped: LIVE=1 not set\n");
    process.exitCode = 0;
    return;
  }

  const scriptedToolCalls = args.scriptedPath
    ? JSON.parse(await fs.readFile(args.scriptedPath, "utf-8"))
    : undefined;

  const transcript = await harness.runEval({
    prompt: args.prompt,
    sessionSeed: args.sessionSeed,
    mode: args.mode,
    scriptedToolCalls,
    finalReplyText: args.finalReplyText,
  });
  process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
