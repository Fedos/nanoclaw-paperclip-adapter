import { describe, it, expect } from "vitest";
import { signPayload, verifySignature } from "./hmac.js";

describe("hmac signing", () => {
  const fixedNow = () => 1_700_000_000_000;

  it("round-trips signPayload -> verifySignature", () => {
    const sig = signPayload("shhh", '{"a":1}', fixedNow);
    expect(sig.timestamp).toBe("1700000000");
    expect(sig.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(
      verifySignature("shhh", '{"a":1}', sig.timestamp, sig.signature, 300, fixedNow),
    ).toBe(true);
  });

  it("rejects mismatched secret", () => {
    const sig = signPayload("shhh", "body", fixedNow);
    expect(
      verifySignature("other", "body", sig.timestamp, sig.signature, 300, fixedNow),
    ).toBe(false);
  });

  it("rejects mismatched body", () => {
    const sig = signPayload("shhh", "body", fixedNow);
    expect(
      verifySignature("shhh", "other-body", sig.timestamp, sig.signature, 300, fixedNow),
    ).toBe(false);
  });

  it("rejects stale timestamp outside skew window", () => {
    const sig = signPayload("shhh", "body", fixedNow);
    const later = () => 1_700_000_000_000 + 600_000;
    expect(
      verifySignature("shhh", "body", sig.timestamp, sig.signature, 300, later),
    ).toBe(false);
  });

  it("handles same-length but wrong-hex signatures safely", () => {
    const sig = signPayload("shhh", "body", fixedNow);
    const flipped = sig.signature.replace(/.$/, (c) =>
      c === "0" ? "1" : "0",
    );
    expect(verifySignature("shhh", "body", sig.timestamp, flipped, 300, fixedNow)).toBe(false);
  });
});
