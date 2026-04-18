import { createHmac, timingSafeEqual } from "node:crypto";

export interface HmacSignature {
  timestamp: string;
  signature: string;
}

export const HMAC_HEADER_SIGNATURE = "x-paperclip-signature";
export const HMAC_HEADER_TIMESTAMP = "x-paperclip-timestamp";

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

export function verifySignature(
  secret: string,
  body: string,
  timestamp: string,
  signature: string,
  maxSkewSec = 300,
  now: () => number = Date.now,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const skew = Math.abs(Math.floor(now() / 1000) - ts);
  if (skew > maxSkewSec) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}
