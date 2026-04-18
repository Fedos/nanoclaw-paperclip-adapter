/**
 * HMAC signing contract for nanoclaw daemon calls.
 *
 * This module is a **public contract** — the daemon side (see FEDA-94 and
 * `qwibitai/nanoclaw`) MUST implement identical rules or signed
 * requests will be rejected.
 *
 * Canonical signing string:
 *
 *   message = `${timestamp}.${body}`
 *
 * where:
 *   - `timestamp` is decimal unix seconds (integer, no fractional part),
 *     encoded as ASCII digits. Example: "1700000000".
 *   - `body` is the raw HTTP request body bytes decoded as UTF-8. For GET
 *     requests with no body (status poll, health probe) `body` is the empty
 *     string and the signed message is `"${timestamp}."`.
 *   - The separator between `timestamp` and `body` is a single ASCII period
 *     `.` (0x2E).
 *
 * Digest: HMAC-SHA256, output encoded as lowercase hex (64 chars).
 * Secret: UTF-8 encoded bytes of the shared secret string.
 *
 * Headers sent by the adapter (and expected by the daemon):
 *
 *   x-paperclip-timestamp: <unix-seconds>
 *   x-paperclip-signature: <lowercase-hex 64-char hmac-sha256>
 *
 * Clock skew: the daemon MUST reject requests whose timestamp differs from
 * its own clock by more than the configured skew window (default 300s on
 * both sides). Constant-time comparison MUST be used on the signature.
 *
 * Wire format is versioned implicitly via the header names; if the contract
 * ever changes, bump both the header names AND the adapter's
 * `paperclip.adapterUiParser` version.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface HmacSignature {
  timestamp: string;
  signature: string;
}

export const HMAC_HEADER_SIGNATURE = "x-paperclip-signature";
export const HMAC_HEADER_TIMESTAMP = "x-paperclip-timestamp";
export const HMAC_DEFAULT_MAX_SKEW_SEC = 300;

const HEX_SIGNATURE_RE = /^[a-f0-9]{64}$/i;

export type HmacVerifyReason =
  | "ok"
  | "timestamp_not_numeric"
  | "timestamp_skew"
  | "signature_format_invalid"
  | "signature_mismatch";

export function signPayload(
  secret: string,
  body: string,
  now: () => number = Date.now,
): HmacSignature {
  const timestamp = Math.floor(now() / 1000).toString();
  const message = `${timestamp}.${body}`;
  const signature = createHmac("sha256", secret).update(message).digest("hex");
  return { timestamp, signature };
}

/**
 * Verify a signed request. Returns `true` on success, `false` on any failure.
 * Use {@link verifySignatureDetailed} when you need the rejection reason for
 * logging or metrics.
 */
export function verifySignature(
  secret: string,
  body: string,
  timestamp: string,
  signature: string,
  maxSkewSec: number = HMAC_DEFAULT_MAX_SKEW_SEC,
  now: () => number = Date.now,
): boolean {
  return (
    verifySignatureDetailed(secret, body, timestamp, signature, maxSkewSec, now) ===
    "ok"
  );
}

export function verifySignatureDetailed(
  secret: string,
  body: string,
  timestamp: string,
  signature: string,
  maxSkewSec: number = HMAC_DEFAULT_MAX_SKEW_SEC,
  now: () => number = Date.now,
): HmacVerifyReason {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return "timestamp_not_numeric";
  const skew = Math.abs(Math.floor(now() / 1000) - ts);
  if (skew > maxSkewSec) return "timestamp_skew";
  if (!HEX_SIGNATURE_RE.test(signature)) return "signature_format_invalid";
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return "signature_format_invalid";
  return timingSafeEqual(sigBuf, expBuf) ? "ok" : "signature_mismatch";
}
