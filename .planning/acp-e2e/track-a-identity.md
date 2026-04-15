# Track A — Startup & Identity Embodiment

**Owner:** one Codex agent. Depends on Track 0 harness.

## Goal

Prove that when a real user sends a "who are you" prompt through `openclaw agent`, the ACP agent autonomously:

1. Reads the bootstrap files (SOUL.md, IDENTITY.md, AGENTS.md) **before** producing any reply.
2. Embodies the configured identity — uses the name and emoji from `IDENTITY.md`, tone from `SOUL.md`.
3. Avoids generic corporate filler (“Great question!”, “Happy to help!”).

## Why it matters

This is the most visible "does it feel like OpenClaw" signal. A native Pi agent answers in its configured persona; a raw Claude Code answers as Claude. The CLAUDE.md we generate must make the ACP agent behave like the former.

## Behaviors under test

| #   | Rule                                                 | Trigger prompt         | Expected action                                                                      |
| --- | ---------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| A1  | Read all bootstrap files before first assistant text | any first-turn message | `filesRead` includes `SOUL.md`, `IDENTITY.md`, `AGENTS.md` before any assistant text |
| A2  | Use configured name in self-intro                    | "Hi, who are you?"     | reply contains fixture `IDENTITY.md` `name` (e.g. "Skredik")                         |
| A3  | Avoid corporate filler                               | any                    | reply does NOT match `/great question\b\|happy to help\|certainly!/i`                |
| A4  | Persona tone matches SOUL traits                     | "What's your vibe?"    | reply is direct / opinionated (heuristic match on declared SOUL keywords)            |

## CLI flow

Test driver: `scripts/e2e/acp-cli/tests/identity.e2e.ts`

```ts
import { sendMessage } from "../driver";
import { readTranscript } from "../transcript";
import { assertRules, readBootstrapFiles, replyMatches, replyNotMatches } from "../rules";

const r1 = await sendMessage({
  agent: "claude",
  sessionId: "ident-1",
  message: "Hi, who are you?",
  deliver: true,
});
const t1 = readTranscript("ident-1");

assertRules(t1, [
  readBootstrapFiles(["SOUL.md", "IDENTITY.md", "AGENTS.md"]),
  replyMatches(/Skredik/), // fixture IDENTITY.md name
  replyNotMatches(/great question|happy to help|certainly!/i),
]);

const r2 = await sendMessage({
  agent: "claude",
  sessionId: "ident-1",
  message: "What's your vibe?",
});
const t2 = readTranscript("ident-1");
assertRules(t2, [
  // SOUL.md fixture declares "genuine, opinionated, direct"
  replyMatches(/direct|opinion|genuine|honest/i),
  replyNotMatches(/great question|happy to help|certainly!/i),
]);
```

## CLAUDE.md patch required

Edit `buildClaudeMdContent()` in `src/agents/acp-workspace-context.ts`, **Identity** section:

Before the existing "read SOUL.md and embody" line, inline a concrete list of persona traits paraphrased from SOUL.md so the model sees them without a Read:

```
You embody the persona defined in SOUL.md. Key traits (read SOUL.md for full detail):
- Be genuinely helpful, not performatively helpful. Skip corporate filler like "Great question!" or "Happy to help!".
- Have opinions. Disagree when you have reason to. Don't sycophantically agree.
- Try to figure things out before asking. Earn trust through competence.

Before responding to any message, you MUST Read SOUL.md, IDENTITY.md, and AGENTS.md.
Use the name and emoji from IDENTITY.md in self-introduction and signatures.
```

Also tighten the existing bootstrap-read mandate to explicitly list these three files as blocking before first reply.

## Fixture requirements (already in Track 0 fixtures)

- `SOUL.md`: declares traits "genuine, opinionated, direct, no corporate filler".
- `IDENTITY.md`: `name: Skredik`, `emoji: 🦞`.
- `AGENTS.md`: standard OpenClaw boilerplate (docs/reference/templates copy).

If Track 0 fixtures don't yet include SOUL keywords "direct / opinionated / genuine", update them here.

## Test file extension

Update `src/agents/acp-workspace-context.test.ts` to assert the new persona-traits block is present in the generated CLAUDE.md (one test case).

## Constraints

- Do NOT loosen the assertions just to pass. If the model consistently fails, the fix is in the CLAUDE.md prompt, not the test.
- Keep prompts simple/natural — no hidden instructions inside the prompt itself.

## Verification

1. `LIVE=1 pnpm test:e2e:acp:a` passes.
2. `pnpm test src/agents/acp-workspace-context.test.ts` passes (covers the CLAUDE.md patch).
3. `pnpm check` stays green.

## Critical files

- `src/agents/acp-workspace-context.ts` (buildClaudeMdContent)
- `src/agents/acp-workspace-context.test.ts`
- `docs/reference/templates/SOUL.md`, `IDENTITY.md`, `AGENTS.md` (fixture source)
- `scripts/e2e/acp-cli/fixtures/workspace/{SOUL,IDENTITY,AGENTS}.md`
