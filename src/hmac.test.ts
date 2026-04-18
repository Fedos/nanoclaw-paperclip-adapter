import { describe, it, expect } from "vitest";
import { signPayload, verifySignature, verifySignatureDetailed } from "./hmac.js";

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

  it("rejects non-hex signatures without comparing (signature_format_invalid)", () => {
    // 64-char non-hex — must short-circuit before timingSafeEqual or Buffer.from throws.
    const bogus = "z".repeat(64);
    expect(
      verifySignatureDetailed("shhh", "body", "1700000000", bogus, 300, fixedNow),
    ).toBe("signature_format_invalid");
  });

  it("rejects wrong-length signatures as signature_format_invalid", () => {
    expect(
      verifySignatureDetailed("shhh", "body", "1700000000", "abcd", 300, fixedNow),
    ).toBe("signature_format_invalid");
  });

  it("reports timestamp_skew for stale requests", () => {
    const sig = signPayload("shhh", "body", fixedNow);
    const later = () => 1_700_000_000_000 + 600_000;
    expect(
      verifySignatureDetailed("shhh", "body", sig.timestamp, sig.signature, 300, later),
    ).toBe("timestamp_skew");
  });

  it("reports timestamp_not_numeric for garbage timestamps", () => {
    expect(
      verifySignatureDetailed(
        "shhh",
        "body",
        "not-a-number",
        "a".repeat(64),
        300,
        fixedNow,
      ),
    ).toBe("timestamp_not_numeric");
  });

  it("returns 'ok' on a good signature via detailed API", () => {
    const sig = signPayload("shhh", "body", fixedNow);
    expect(
      verifySignatureDetailed("shhh", "body", sig.timestamp, sig.signature, 300, fixedNow),
    ).toBe("ok");
  });
});
