import { describe, it, expect } from "vitest";
import { NdjsonSplitter, parseFrame } from "./ndjson.js";

describe("NdjsonSplitter", () => {
  it("emits complete lines and buffers partial ones", () => {
    const s = new NdjsonSplitter();
    expect(s.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(s.push('2}\n')).toEqual(['{"b":2}']);
    expect(s.flush()).toBeNull();
  });

  it("returns a trailing partial on flush", () => {
    const s = new NdjsonSplitter();
    s.push('{"a":1}\npartial');
    expect(s.flush()).toBe("partial");
    expect(s.flush()).toBeNull();
  });

  it("handles Uint8Array input", () => {
    const s = new NdjsonSplitter();
    const bytes = Buffer.from('{"k":"v"}\n', "utf8");
    expect(s.push(bytes)).toEqual(['{"k":"v"}']);
  });
});

describe("parseFrame", () => {
  it("returns null for empty input", () => {
    expect(parseFrame("")).toBeNull();
    expect(parseFrame("   ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseFrame("not json")).toBeNull();
  });

  it("returns null for objects without type", () => {
    expect(parseFrame('{"kind":"log"}')).toBeNull();
  });

  it("passes through valid frames", () => {
    expect(parseFrame('{"type":"log","stream":"stdout","chunk":"hi"}')).toEqual({
      type: "log",
      stream: "stdout",
      chunk: "hi",
    });
  });
});
