import type { EvalTranscript, EvalToolCall } from "./harness.js";
import { EVAL_BOOTSTRAP_FILES } from "./harness.js";

export type EvalRuleResult = {
  ok: boolean;
  message: string;
};

export type EvalRule = (transcript: EvalTranscript) => EvalRuleResult;

export function allOf(...rules: EvalRule[]): EvalRule {
  return (transcript) => {
    for (const rule of rules) {
      const result = rule(transcript);
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true, message: "all rules passed" };
  };
}

export function anyOf(...rules: EvalRule[]): EvalRule {
  return (transcript) => {
    const failures: string[] = [];
    for (const rule of rules) {
      const result = rule(transcript);
      if (result.ok) {
        return { ok: true, message: result.message };
      }
      failures.push(result.message);
    }
    return {
      ok: false,
      message: `expected any rule to pass:\n- ${failures.join("\n- ")}`,
    };
  };
}

export function not(rule: EvalRule, message?: string): EvalRule {
  return (transcript) => {
    const result = rule(transcript);
    if (!result.ok) {
      return { ok: true, message: message ?? `negated rule passed: ${result.message}` };
    }
    return { ok: false, message: message ?? `negated rule failed: ${result.message}` };
  };
}

export function mustCallTool(
  name: string,
  argsMatcher?: (args: unknown, call: EvalToolCall) => boolean,
): EvalRule {
  return (transcript) => {
    const call = transcript.toolCalls.find(
      (entry) =>
        toolNameMatches(entry.name, name) && (!argsMatcher || argsMatcher(entry.args, entry)),
    );
    if (call) {
      return { ok: true, message: `tool called: ${call.name}` };
    }
    return {
      ok: false,
      message: `expected tool call "${name}" but saw ${summarizeToolCalls(transcript)}`,
    };
  };
}

export function mustNotCallTool(name: string): EvalRule {
  return (transcript) => {
    const call = transcript.toolCalls.find((entry) => toolNameMatches(entry.name, name));
    if (!call) {
      return { ok: true, message: `tool not called: ${name}` };
    }
    return { ok: false, message: `expected tool "${name}" to be absent but saw ${call.name}` };
  };
}

export function replyMatches(pattern: RegExp | string): EvalRule {
  const regex = typeof pattern === "string" ? new RegExp(pattern, "u") : pattern;
  return (transcript) =>
    regex.test(transcript.replyText)
      ? { ok: true, message: `reply matched ${regex}` }
      : {
          ok: false,
          message: `expected reply to match ${regex}, got ${JSON.stringify(transcript.replyText)}`,
        };
}

export function replyIsExact(expected: string): EvalRule {
  return (transcript) =>
    transcript.replyText === expected
      ? { ok: true, message: "reply matched exactly" }
      : {
          ok: false,
          message: `expected exact reply ${JSON.stringify(expected)}, got ${JSON.stringify(transcript.replyText)}`,
        };
}

export function calledInOrder(...names: string[]): EvalRule {
  return (transcript) => {
    let cursor = 0;
    const matched: string[] = [];
    for (const call of transcript.toolCalls) {
      if (cursor >= names.length) {
        break;
      }
      if (toolNameMatches(call.name, names[cursor])) {
        matched.push(call.name);
        cursor += 1;
      }
    }
    if (cursor === names.length) {
      return { ok: true, message: `tools called in order: ${names.join(" -> ")}` };
    }
    return {
      ok: false,
      message: `expected tool order ${names.join(" -> ")}, matched ${matched.join(" -> ") || "<none>"}`,
    };
  };
}

export function readBootstrapFiles(names: readonly string[] = EVAL_BOOTSTRAP_FILES): EvalRule {
  return (transcript) => {
    const missing = names.filter(
      (name) => !transcript.filesRead.some((entry) => filePathMatches(entry, name)),
    );
    if (missing.length === 0) {
      return { ok: true, message: "bootstrap files were read" };
    }
    return {
      ok: false,
      message: `expected bootstrap reads for ${missing.join(", ")}, saw ${transcript.filesRead.join(", ") || "<none>"}`,
    };
  };
}

export function assertRules(transcript: EvalTranscript, rules: EvalRule[]): void {
  for (const rule of rules) {
    const result = rule(transcript);
    if (!result.ok) {
      throw new Error(`${result.message}\n${formatTranscriptSummary(transcript)}`);
    }
  }
}

function summarizeToolCalls(transcript: EvalTranscript): string {
  if (transcript.toolCalls.length === 0) {
    return "<none>";
  }
  return transcript.toolCalls.map((call) => call.name).join(", ");
}

function formatTranscriptSummary(transcript: EvalTranscript): string {
  return [
    "Transcript summary:",
    `toolCalls: ${summarizeToolCalls(transcript)}`,
    `filesRead: ${transcript.filesRead.join(", ") || "<none>"}`,
    `filesWritten: ${transcript.filesWritten.join(", ") || "<none>"}`,
    `replyText: ${JSON.stringify(transcript.replyText)}`,
  ].join("\n");
}

function toolNameMatches(actual: string, expected: string): boolean {
  return actual.trim().toLowerCase() === expected.trim().toLowerCase();
}

function filePathMatches(actual: string, expected: string): boolean {
  const normalizedActual = actual.replaceAll("\\", "/");
  const normalizedExpected = expected.replaceAll("\\", "/");
  return (
    normalizedActual === normalizedExpected ||
    normalizedActual.endsWith(`/${normalizedExpected}`) ||
    normalizedActual.endsWith(`/${normalizedExpected.toLowerCase()}`) ||
    normalizedActual.toLowerCase() === normalizedExpected.toLowerCase()
  );
}
