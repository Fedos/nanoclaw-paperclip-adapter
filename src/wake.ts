import { request, type Dispatcher } from "undici";
import { HMAC_HEADER_SIGNATURE, HMAC_HEADER_TIMESTAMP, signPayload } from "./hmac.js";
import { NdjsonSplitter, parseFrame, type NdjsonDoneFrame } from "./ndjson.js";
import type { NanoclawAdapterConfig } from "./config.js";

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

const POLL_INTERVAL_MS = 2000;

function buildSignedHeaders(
  config: NanoclawAdapterConfig,
  body: string,
  now: () => number,
): Record<string, string> {
  const sig = signPayload(config.hmacSecret, body, now);
  return {
    "content-type": "application/json",
    "user-agent": "nanoclaw-paperclip-adapter/0.1.0",
    [HMAC_HEADER_TIMESTAMP]: sig.timestamp,
    [HMAC_HEADER_SIGNATURE]: sig.signature,
  };
}

async function streamFrames(
  body: Dispatcher.ResponseData["body"],
  onLog: LogSink,
): Promise<{ terminal: NdjsonDoneFrame | null; streamError: Error | null }> {
  const splitter = new NdjsonSplitter();
  let terminal: NdjsonDoneFrame | null = null;
  let streamError: Error | null = null;

  try {
    for await (const chunk of body) {
      const lines = splitter.push(chunk as Uint8Array);
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
    const tail = splitter.flush();
    if (tail) {
      const frame = parseFrame(tail);
      if (frame && frame.type === "done") terminal = frame as NdjsonDoneFrame;
    }
  } catch (err) {
    streamError = err instanceof Error ? err : new Error(String(err));
  }

  return { terminal, streamError };
}

async function pollForResult(
  config: NanoclawAdapterConfig,
  runId: string,
  deps: Required<Pick<WakeDeps, "request" | "now">>,
  signal: AbortSignal,
  overallDeadlineMs: number,
): Promise<{ terminal: NdjsonDoneFrame; attempts: number }> {
  const url = `${config.daemonUrl}/paperclip/runs/${encodeURIComponent(runId)}`;
  let attempts = 0;
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
        try {
          const json = JSON.parse(text);
          const status = typeof json?.status === "string" ? json.status : null;
          if (status === "done" || status === "error" || status === "timeout") {
            const terminal: NdjsonDoneFrame = {
              type: "done",
              exitCode:
                typeof json.exitCode === "number"
                  ? json.exitCode
                  : status === "done"
                    ? 0
                    : 1,
              signal: typeof json.signal === "string" ? json.signal : null,
              timedOut: status === "timeout",
              errorMessage:
                typeof json.errorMessage === "string"
                  ? json.errorMessage
                  : status === "error"
                    ? "daemon reported error"
                    : null,
              usage: json.usage,
              sessionParams: json.sessionParams ?? null,
              sessionDisplayId:
                typeof json.sessionDisplayId === "string"
                  ? json.sessionDisplayId
                  : null,
              provider:
                typeof json.provider === "string" ? json.provider : null,
              model: typeof json.model === "string" ? json.model : null,
              costUsd:
                typeof json.costUsd === "number" ? json.costUsd : null,
              summary:
                typeof json.summary === "string" ? json.summary : null,
              resultJson:
                json.resultJson && typeof json.resultJson === "object"
                  ? json.resultJson
                  : null,
            };
            return { terminal, attempts };
          }
        } catch {
          // non-JSON — treat as still running and keep polling
        }
      } else if (res.statusCode === 404) {
        throw new WakeError(
          `daemon has no record of run ${runId}`,
          "daemon_missing_terminal_frame",
          { attempts },
        );
      }
    } catch (err) {
      if (err instanceof WakeError) throw err;
      // transient — fall through to sleep
    }
    await new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, POLL_INTERVAL_MS);
      (handle as NodeJS.Timeout).unref?.();
    });
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
  const payload = JSON.stringify(body);
  const controller = new AbortController();
  const overallDeadlineMs = now() + config.timeoutSec * 1000;

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
    throw new WakeError(
      `nanoclaw daemon unreachable at ${config.daemonUrl}: ${(err as Error).message}`,
      "daemon_unreachable",
      { cause: String(err) },
    );
  }

  if (res.statusCode === 401 || res.statusCode === 403) {
    await res.body.text().catch(() => "");
    throw new WakeError(
      `daemon rejected signed wake (status ${res.statusCode}) — check hmacSecret`,
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

  const { terminal, streamError } = await streamFrames(res.body, onLog);
  if (terminal) {
    return { done: terminal, reconnected: false, pollAttempts: 0 };
  }

  // Disconnected before terminal frame — fall back to polling.
  await onLog(
    "stdout",
    `[nanoclaw] stream closed without terminal frame${streamError ? ` (${streamError.message})` : ""}; polling status endpoint\n`,
  );

  try {
    const { terminal: polled, attempts } = await pollForResult(
      config,
      body.runId,
      { request: doRequest, now },
      controller.signal,
      overallDeadlineMs,
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
}
