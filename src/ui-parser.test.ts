import { describe, it, expect } from "vitest";
import { createStdoutParser, parseStdoutLine } from "./ui-parser.js";

describe("ui-parser", () => {
  const ts = "2026-04-18T09:30:00.000Z";

  it("maps [nanoclaw] system lines to system entries", () => {
    const entries = parseStdoutLine("[nanoclaw] dispatching wake", ts);
    expect(entries).toEqual([
      { kind: "system", ts, text: "[nanoclaw] dispatching wake" },
    ]);
  });

  it("maps assistant frames", () => {
    const entries = parseStdoutLine(
      '{"type":"assistant","text":"hi","delta":true}',
      ts,
    );
    expect(entries).toEqual([
      { kind: "assistant", ts, text: "hi", delta: true },
    ]);
  });

  it("maps tool_call frames", () => {
    const entries = parseStdoutLine(
      '{"type":"tool_call","name":"bash","input":{"cmd":"ls"},"toolUseId":"abc"}',
      ts,
    );
    expect(entries).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "bash",
        input: { cmd: "ls" },
        toolUseId: "abc",
      },
    ]);
  });

  it("maps tool_result with error flag", () => {
    const entries = parseStdoutLine(
      '{"type":"tool_result","toolUseId":"abc","content":"boom","isError":true}',
      ts,
    );
    expect(entries[0]).toMatchObject({
      kind: "tool_result",
      toolUseId: "abc",
      content: "boom",
      isError: true,
    });
  });

  it("recurses into nested log envelopes", () => {
    const inner = '{"type":"assistant","text":"nested"}';
    const entries = parseStdoutLine(
      JSON.stringify({ type: "log", stream: "stdout", chunk: `${inner}\n` }),
      ts,
    );
    expect(entries).toEqual([
      { kind: "assistant", ts, text: "nested", delta: false },
    ]);
  });

  it("drops terminal done frames from the transcript", () => {
    expect(parseStdoutLine('{"type":"done","exitCode":0}', ts)).toEqual([]);
  });

  it("falls back to stdout for non-JSON lines", () => {
    const entries = parseStdoutLine("raw log line", ts);
    expect(entries).toEqual([{ kind: "stdout", ts, text: "raw log line" }]);
  });

  it("createStdoutParser exposes parseLine", () => {
    const parser = createStdoutParser();
    expect(parser.parseLine('{"type":"system","text":"ok"}', ts)).toEqual([
      { kind: "system", ts, text: "ok" },
    ]);
  });
});
