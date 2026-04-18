import { request, type Dispatcher } from "undici";
import { HMAC_HEADER_SIGNATURE, HMAC_HEADER_TIMESTAMP, signPayload } from "./hmac.js";
import {
  NdjsonBufferOverflowError,
  NdjsonSplitter,
  parseFrame,
  type NdjsonDoneFrame,
} from "./ndjson.js";
import type { NanoclawAdapterConfig } from "./config.js";
import { USER_AGENT } from "./version.js";

export interface WakeRequestBody {
  runId: string;
  taskId?: string | null;
  agentId: string;
  containerId: string;
  workspacePath: string;
  wakePayload: Record<string, unknown>;
  callbackUrl?: string | null;
  callbackJwt?: string | null;
}

export interface LogSink {
  (stream: "stdout" | "stderr", chunk: string): Promise<void> | void;
}

export interface WakeDeps {
  /** Undici `request` — injectable for testing against a MockAgent. */
  request?: typeof request;
  /** Timer helpers — injectable for deterministic polling tests. */
  setTimeout?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimeout?: (handle: unknown) => void;
  /** Clock — injectable for deterministic HMAC timestamps. */
  now?: () => number;
  /** Base poll interval in ms, used for the backoff seed. Defaults to 2000. */
  pollIntervalMs?: number;
  /** Max poll interval in ms after backoff. Defaults to 30_000. */
  pollMaxIntervalMs?: number;
  /**
   * Max consecutive transient poll failures before the wake gives up
   * (independent of timeoutSec, to avoid grinding against a dead daemon
   * for the full wake timeout). Defaults to 20.
   */
  pollMaxConsecutiveFailures?: number;
}

export interface WakeOutcome {
  done: NdjsonDoneFrame;
  reconnected: boolean;
  pollAttempts: number;
}

export class WakeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "daemon_unreachable"
      | "daemon_http_error"
      | "daemon_stream_error"
      | "daemon_missing_terminal_frame"
      | "poll_timeout"
      | "aborted",
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WakeError";
  }
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_MAX_INTERVAL_MS = 30_000;
const DEFAULT_POLL_MAX_CONSECUTIVE_FAILURES = 20;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const handle = setTimeout(resolve, ms);
    (handle as NodeJS.Timeout).unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(handle);
        resolve();
      },
      { once: true },
    );
  });
}

function buildSignedHeaders(
  config: NanoclawAdapterConfig,
  body: string,
  now: () => number,
): Record<string, string> {
  const sig = signPayload(config.hmacSecret, body, now);
  return {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    [HMAC_HEADER_TIMESTAMP]: sig.timestamp,
    [HMAC_HEADER_SIGNATURE]: sig.signature,
  };
}

/**
 * Parse a `GET /paperclip/runs/{runId}` response body into a terminal
 * {@link NdjsonDoneFrame}. Returns `null` when the run is still in progress
 * (e.g. `status: "running"`) or the body is not valid JSON.
 *
 * Exported so the nanoclaw-side unit tests can reuse the exact
 * adapter-side parser rather than re-implementing it.
 */
export function parsePollResult(text: string): NdjsonDoneFrame | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const status = typeof obj.status === "string" ? obj.status : null;
  if (status !== "done" && status !== "error" && status !== "timeout") {
    return null;
  }
  const exitCode =
    typeof obj.exitCode === "number"
      ? obj.exitCode
      : status === "done"
        ? 0
        : 1;
  const usage =
    obj.usage && typeof obj.usage === "object"
      ? (obj.usage as NdjsonDoneFrame["usage"])
      : undefined;
  const terminal: NdjsonDoneFrame = {
    type: "done",
    exitCode,
    signal: typeof obj.signal === "string" ? obj.signal : null,
    timedOut: status === "timeout",
    errorMessage:
      typeof obj.errorMessage === "string"
        ? obj.errorMessage
        : status === "error"
          ? "daemon reported error"
          : null,
    usage,
    sessionParams:
      obj.sessionParams && typeof obj.sessionParams === "object"
        ? (obj.sessionParams as Record<string, unknown>)
        : null,
    sessionDisplayId:
      typeof obj.sessionDisplayId === "string" ? obj.sessionDisplayId : null,
    provider: typeof obj.provider === "string" ? obj.provider : null,
    model: typeof obj.model === "string" ? obj.model : null,
    costUsd: typeof obj.costUsd === "number" ? obj.costUsd : null,
    summary: typeof obj.summary === "string" ? obj.summary : null,
    resultJson:
      obj.resultJson && typeof obj.resultJson === "object"
        ? (obj.resultJson as Record<string, unknown>)
        : null,
  };
  return terminal;
}

async function streamFrames(
  body: Dispatcher.ResponseData["body"],
  onLog: LogSink,
): Promise<{
  terminal: NdjsonDoneFrame | null;
  streamError: Error | null;
  overflow: NdjsonBufferOverflowError | null;
}> {
  const splitter = new NdjsonSplitter();
  let terminal: NdjsonDoneFrame | null = null;
  let streamError: Error | null = null;
  let overflow: NdjsonBufferOverflowError | null = null;

  try {
    for await (const chunk of body) {
      let lines: string[];
      try {
        lines = splitter.push(chunk as Uint8Array);
      } catch (err) {
        if (err instanceof NdjsonBufferOverflowError) {
          overflow = err;
          break;
        }
        throw err;
      }
      for (const line of lines) {
        const frame = parseFrame(line);
        if (!frame) continue;
        if (frame.type === "log") {
          const logFrame = frame as { stream?: string; chunk?: string };
          const stream =
            logFrame.stream === "stderr" ? "stderr" : "stdout";
          const text = typeof logFrame.chunk === "string" ? logFrame.chunk : "";
          if (text.length > 0) await onLog(stream, text);
        } else if (frame.type === "done") {
          terminal = frame as NdjsonDoneFrame;
        }
      }
    }
    if (!overflow) {
      const tail = splitter.flush();
      if (tail) {
        const frame = parseFrame(tail);
        if (frame && frame.type === "done") terminal = frame as NdjsonDoneFrame;
      }
    }
  } catch (err) {
    streamError = err instanceof Error ? err : new Error(String(err));
  }

  return { terminal, streamError, overflow };
}

async function pollForResult(
  config: NanoclawAdapterConfig,
  runId: string,
  deps: Required<Pick<WakeDeps, "request" | "now">> & {
    pollIntervalMs: number;
    pollMaxIntervalMs: number;
    pollMaxConsecutiveFailures: number;
  },
  signal: AbortSignal,
  overallDeadlineMs: number,
  onLog: LogSink,
): Promise<{ terminal: NdjsonDoneFrame; attempts: number }> {
  const url = `${config.daemonUrl}/paperclip/runs/${encodeURIComponent(runId)}`;
  let attempts = 0;
  let transientFailures = 0;
  let interval = deps.pollIntervalMs;
  while (true) {
    if (signal.aborted) throw new WakeError("wake aborted", "aborted");
    if (deps.now() > overallDeadlineMs) {
      throw new WakeError("poll timeout waiting for daemon result", "poll_timeout", {
        attempts,
      });
    }
    attempts += 1;
    const body = "";
    try {
      const res = await deps.request(url, {
        method: "GET",
        headers: buildSignedHeaders(config, body, deps.now),
        signal,
      });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const text = await res.body.text();
        const terminal = parsePollResult(text);
        if (terminal) {
          return { terminal, attempts };
        }
        // Non-terminal status (e.g. `running`) or non-JSON body — reset
        // backoff and keep polling at the base interval.
        interval = deps.pollIntervalMs;
        transientFailures = 0;
      } else if (res.statusCode === 404) {
        await res.body.text().catch(() => "");
        throw new WakeError(
          `daemon has no record of run ${runId}`,
          "daemon_missing_terminal_frame",
          { attempts },
        );
      } else {
        await res.body.text().catch(() => "");
        transientFailures += 1;
        await onLog(
          "stderr",
          `[nanoclaw] poll attempt ${attempts} got HTTP ${res.statusCode}; backing off to ${Math.round(interval / 1000)}s\n`,
        );
        interval = Math.min(interval * 2, deps.pollMaxIntervalMs);
      }
    } catch (err) {
      if (err instanceof WakeError) throw err;
      transientFailures += 1;
      await onLog(
        "stderr",
        `[nanoclaw] poll attempt ${attempts} failed (${(err as Error).message}); backing off to ${Math.round(interval / 1000)}s\n`,
      );
      interval = Math.min(interval * 2, deps.pollMaxIntervalMs);
    }
    if (transientFailures >= deps.pollMaxConsecutiveFailures) {
      throw new WakeError(
        `poll abandoned after ${transientFailures} consecutive transient failures`,
        "daemon_stream_error",
        { attempts, transientFailures },
      );
    }
    await sleep(interval, signal);
  }
}

/**
 * Execute a nanoclaw wake: POST the request, stream NDJSON frames, and on
 * disconnect poll the status endpoint until the daemon reports terminal state.
 */
export async function executeWake(
  config: NanoclawAdapterConfig,
  body: WakeRequestBody,
  onLog: LogSink,
  deps: WakeDeps = {},
): Promise<WakeOutcome> {
  const now = deps.now ?? Date.now;
  const doRequest = deps.request ?? request;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollMaxIntervalMs = deps.pollMaxIntervalMs ?? DEFAULT_POLL_MAX_INTERVAL_MS;
  const pollMaxConsecutiveFailures =
    deps.pollMaxConsecutiveFailures ?? DEFAULT_POLL_MAX_CONSECUTIVE_FAILURES;
  const payload = JSON.stringify(body);
  const controller = new AbortController();
  const overallDeadlineMs = now() + config.timeoutSec * 1000;

  // Enforce timeoutSec across both the stream and the poll fallback by aborting
  // the controller when the overall deadline elapses. Without this, a daemon
  // holding the NDJSON stream open past timeoutSec would run unbounded.
  let deadlineFired = false;
  const deadlineTimer = setTimeout(() => {
    deadlineFired = true;
    controller.abort();
  }, Math.max(0, overallDeadlineMs - now()));
  (deadlineTimer as NodeJS.Timeout).unref?.();

  const fail = (err: unknown): never => {
    if (deadlineFired) {
      throw new WakeError(
        `wake exceeded timeoutSec=${config.timeoutSec}s`,
        "poll_timeout",
        { cause: String(err) },
      );
    }
    throw err;
  };

  try {
    let res: Dispatcher.ResponseData;
    try {
      res = await doRequest(`${config.daemonUrl}/paperclip/wake`, {
        method: "POST",
        headers: buildSignedHeaders(config, payload, now),
        body: payload,
        signal: controller.signal,
        bodyTimeout: 0,
        headersTimeout: 30_000,
      });
    } catch (err) {
      if (deadlineFired) {
        throw new WakeError(
          `wake exceeded timeoutSec=${config.timeoutSec}s before daemon responded`,
          "poll_timeout",
          { cause: String(err) },
        );
      }
      throw new WakeError(
        `nanoclaw daemon unreachable at ${config.daemonUrl}: ${(err as Error).message}`,
        "daemon_unreachable",
        { cause: String(err) },
      );
    }

    if (res.statusCode === 401 || res.statusCode === 403) {
      await res.body.text().catch(() => "");
      throw new WakeError(
        `daemon rejected signed wake (status ${res.statusCode}) — check hmacSecret / clock skew`,
        "daemon_http_error",
        { status: res.statusCode },
      );
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const snippet = await res.body.text().catch(() => "");
      throw new WakeError(
        `daemon returned HTTP ${res.statusCode}`,
        "daemon_http_error",
        { status: res.statusCode, body: snippet.slice(0, 500) },
      );
    }

    const { terminal, streamError, overflow } = await streamFrames(res.body, onLog);
    if (deadlineFired) {
      throw new WakeError(
        `wake exceeded timeoutSec=${config.timeoutSec}s during stream`,
        "poll_timeout",
        { cause: streamError ? String(streamError) : null },
      );
    }
    if (overflow) {
      throw new WakeError(
        overflow.message,
        "daemon_stream_error",
        { bufferBytes: overflow.bufferBytes, limitBytes: overflow.limitBytes },
      );
    }
    if (terminal) {
      return { done: terminal, reconnected: false, pollAttempts: 0 };
    }

    // Disconnected before terminal frame — grace-sleep (give the daemon a
    // chance to finalize), then fall back to polling. Both bounded by
    // overallDeadlineMs via the controller timer.
    await onLog(
      "stdout",
      `[nanoclaw] stream closed without terminal frame${streamError ? ` (${streamError.message})` : ""}; waiting ${config.graceSec}s then polling status endpoint\n`,
    );
    if (config.graceSec > 0) {
      await sleep(config.graceSec * 1000, controller.signal);
      if (deadlineFired) {
        throw new WakeError(
          `wake exceeded timeoutSec=${config.timeoutSec}s during grace window`,
          "poll_timeout",
        );
      }
    }

    try {
      const { terminal: polled, attempts } = await pollForResult(
        config,
        body.runId,
        {
          request: doRequest,
          now,
          pollIntervalMs,
          pollMaxIntervalMs,
          pollMaxConsecutiveFailures,
        },
        controller.signal,
        overallDeadlineMs,
        onLog,
      );
      return { done: polled, reconnected: true, pollAttempts: attempts };
    } catch (err) {
      if (err instanceof WakeError) throw err;
      throw new WakeError(
        `failed to recover daemon result: ${(err as Error).message}`,
        "daemon_stream_error",
        { cause: String(err) },
      );
    }
  } catch (err) {
    if (err instanceof WakeError) {
      // An `aborted` WakeError when we know the deadline fired is really
      // the wake timeout — rename it so the result bubbles up as timedOut.
      if (deadlineFired && err.code === "aborted") {
        throw new WakeError(
          `wake exceeded timeoutSec=${config.timeoutSec}s during poll`,
          "poll_timeout",
          { cause: err.message },
        );
      }
      throw err;
    }
    return fail(err);
  } finally {
    clearTimeout(deadlineTimer);
  }
}
