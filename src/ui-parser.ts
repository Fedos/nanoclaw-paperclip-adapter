/**
 * Browser-safe UI parser for nanoclaw NDJSON log frames.
 *
 * Paperclip's run viewer calls `createStdoutParser()` and then feeds each stdout
 * line into `parseLine(line, ts)`. We translate nanoclaw's NDJSON frames into
 * Paperclip `TranscriptEntry` records so the UI renders tool cards, assistant
 * text, and system notices natively.
 *
 * This module MUST stay importable in browsers: no Node-only APIs.
 */

export interface TranscriptEntry {
  kind:
    | "assistant"
    | "thinking"
    | "user"
    | "tool_call"
    | "tool_result"
    | "init"
    | "result"
    | "stderr"
    | "system"
    | "stdout";
  ts: string;
  [key: string]: unknown;
}

export interface StdoutParser {
  parseLine(line: string, ts: string): TranscriptEntry[];
}

interface UiFrame {
  type: string;
  [key: string]: unknown;
}

function safeParse(line: string): UiFrame | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as UiFrame) : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (line.startsWith("[nanoclaw]")) {
    return [{ kind: "system", ts, text: line.trimEnd() }];
  }

  const frame = safeParse(line);
  if (!frame) {
    const text = line.trimEnd();
    if (!text) return [];
    return [{ kind: "stdout", ts, text }];
  }

  switch (frame.type) {
    case "assistant":
      return [
        {
          kind: "assistant",
          ts,
          text: asString(frame.text),
          delta: frame.delta === true,
        },
      ];
    case "thinking":
      return [
        {
          kind: "thinking",
          ts,
          text: asString(frame.text),
          delta: frame.delta === true,
        },
      ];
    case "tool_call":
      return [
        {
          kind: "tool_call",
          ts,
          name: asString(frame.name) || "tool",
          input: frame.input ?? null,
          toolUseId:
            typeof frame.toolUseId === "string" ? frame.toolUseId : undefined,
        },
      ];
    case "tool_result": {
      const content = asString(frame.content);
      return [
        {
          kind: "tool_result",
          ts,
          toolUseId:
            typeof frame.toolUseId === "string" ? frame.toolUseId : "",
          toolName:
            typeof frame.toolName === "string" ? frame.toolName : undefined,
          content,
          isError: frame.isError === true,
        },
      ];
    }
    case "init":
      return [
        {
          kind: "init",
          ts,
          model: asString(frame.model),
          sessionId: asString(frame.sessionId),
        },
      ];
    case "system":
      return [{ kind: "system", ts, text: asString(frame.text) }];
    case "stderr":
      return [{ kind: "stderr", ts, text: asString(frame.text) }];
    case "result": {
      return [
        {
          kind: "result",
          ts,
          text: asString(frame.text),
          inputTokens:
            typeof frame.inputTokens === "number" ? frame.inputTokens : 0,
          outputTokens:
            typeof frame.outputTokens === "number" ? frame.outputTokens : 0,
          cachedTokens:
            typeof frame.cachedTokens === "number" ? frame.cachedTokens : 0,
          costUsd: typeof frame.costUsd === "number" ? frame.costUsd : 0,
          subtype: asString(frame.subtype),
          isError: frame.isError === true,
          errors: Array.isArray(frame.errors) ? frame.errors : [],
        },
      ];
    }
    case "log": {
      // Nested "log" envelope — recurse into the inner chunk.
      const chunk = asString(frame.chunk);
      if (!chunk) return [];
      return chunk
        .split("\n")
        .filter((l) => l.length > 0)
        .flatMap((l) => parseStdoutLine(l, ts));
    }
    case "done":
      // Surfaced separately in the run result; don't duplicate in the transcript.
      return [];
    default:
      return [{ kind: "stdout", ts, text: line.trimEnd() }];
  }
}

export function createStdoutParser(): StdoutParser {
  return {
    parseLine(line: string, ts: string): TranscriptEntry[] {
      return parseStdoutLine(line, ts);
    },
  };
}

export default createStdoutParser;
