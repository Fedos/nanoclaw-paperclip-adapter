import { describe, it, expect } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { executeWake, parsePollResult, WakeError } from "./wake.js";
import {
  verifySignature,
  HMAC_HEADER_SIGNATURE,
  HMAC_HEADER_TIMESTAMP,
} from "./hmac.js";
import type { NanoclawAdapterConfig } from "./config.js";

const SECRET = "test-secret";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void> | void;

async function startServer(handler: Handler): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        await handler(req, res, body);
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((r) => server.close(() => r())),
    server,
  };
}

function makeConfig(daemonUrl: string): NanoclawAdapterConfig {
  return {
    daemonUrl,
    containerId: "container-1",
    hmacSecret: SECRET,
    timeoutSec: 30,
    graceSec: 10,
    workspacePath: "/workspace/group",
  };
}

describe("executeWake", () => {
  it("streams NDJSON frames and returns the terminal done frame", async () => {
    const captured: { stream: string; chunk: string }[] = [];
    const { url, close } = await startServer((req, res, body) => {
      expect(req.url).toBe("/paperclip/wake");
      const ts = req.headers[HMAC_HEADER_TIMESTAMP] as string;
      const sig = req.headers[HMAC_HEADER_SIGNATURE] as string;
      expect(verifySignature(SECRET, body, ts, sig)).toBe(true);
      res.statusCode = 200;
      res.setHeader("content-type", "application/x-ndjson");
      res.write(
        JSON.stringify({ type: "log", stream: "stdout", chunk: "hello\n" }) + "\n",
      );
      res.write(
        JSON.stringify({ type: "log", stream: "stderr", chunk: "warn\n" }) + "\n",
      );
      res.write(
        JSON.stringify({
          type: "done",
          exitCode: 0,
          usage: { inputTokens: 10, outputTokens: 20 },
          summary: "ok",
        }) + "\n",
      );
      res.end();
    });
    try {
      const outcome = await executeWake(
        makeConfig(url),
        {
          runId: "run-1",
          agentId: "a",
          containerId: "container-1",
          workspacePath: "/workspace/group",
          wakePayload: {},
        },
        async (stream, chunk) => {
          captured.push({ stream, chunk });
        },
      );
      expect(outcome.reconnected).toBe(false);
      expect(outcome.done.exitCode).toBe(0);
      expect(outcome.done.summary).toBe("ok");
      expect(captured).toEqual([
        { stream: "stdout", chunk: "hello\n" },
        { stream: "stderr", chunk: "warn\n" },
      ]);
    } finally {
      await close();
    }
  });

  it("throws daemon_http_error on 401", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.statusCode = 401;
      res.end("nope");
    });
    try {
      await expect(
        executeWake(
          makeConfig(url),
          {
            runId: "run-x",
            agentId: "a",
            containerId: "c",
            workspacePath: "/w",
            wakePayload: {},
          },
          async () => {},
        ),
      ).rejects.toMatchObject({ code: "daemon_http_error" });
    } finally {
      await close();
    }
  });

  it("falls back to polling when the stream closes early", async () => {
    let pollCount = 0;
    const { url, close } = await startServer((req, res) => {
      if (req.url === "/paperclip/wake") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/x-ndjson");
        res.write(
          JSON.stringify({ type: "log", stream: "stdout", chunk: "partial\n" }) + "\n",
        );
        res.end(); // no terminal frame
        return;
      }
      if (req.url?.startsWith("/paperclip/runs/")) {
        pollCount += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        if (pollCount < 2) {
          res.end(JSON.stringify({ status: "running" }));
        } else {
          res.end(
            JSON.stringify({
              status: "done",
              exitCode: 0,
              summary: "recovered",
              sessionDisplayId: "sess-42",
            }),
          );
        }
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    try {
      const outcome = await executeWake(
        makeConfig(url),
        {
          runId: "run-poll",
          agentId: "a",
          containerId: "c",
          workspacePath: "/w",
          wakePayload: {},
        },
        async () => {},
      );
      expect(outcome.reconnected).toBe(true);
      expect(outcome.done.summary).toBe("recovered");
      expect(pollCount).toBeGreaterThanOrEqual(2);
    } finally {
      await close();
    }
  }, 15_000);

  it("aborts the stream when timeoutSec elapses", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/x-ndjson");
      // Write a partial log line but never terminate — force the deadline.
      res.write(
        JSON.stringify({ type: "log", stream: "stdout", chunk: "keep-alive\n" }) +
          "\n",
      );
      // Leave the connection open; do not end().
    });
    try {
      const cfg: NanoclawAdapterConfig = {
        ...makeConfig(url),
        timeoutSec: 1,
        graceSec: 0,
      };
      await expect(
        executeWake(
          cfg,
          {
            runId: "run-timeout",
            agentId: "a",
            containerId: "c",
            workspacePath: "/w",
            wakePayload: {},
          },
          async () => {},
        ),
      ).rejects.toMatchObject({ code: "poll_timeout" });
    } finally {
      await close();
    }
  }, 10_000);

  it("wraps network failures in WakeError(daemon_unreachable)", async () => {
    // Bind to a free port, then close so connections are refused.
    const { url, close } = await startServer(() => {});
    await close();
    try {
      await executeWake(
        makeConfig(url),
        {
          runId: "r",
          agentId: "a",
          containerId: "c",
          workspacePath: "/w",
          wakePayload: {},
        },
        async () => {},
      );
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WakeError);
      expect((err as WakeError).code).toBe("daemon_unreachable");
    }
  });

  it("skips malformed NDJSON lines mid-stream and still surfaces the done frame", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/x-ndjson");
      res.write(
        JSON.stringify({ type: "log", stream: "stdout", chunk: "before\n" }) + "\n",
      );
      // Mid-stream garbage the parser should drop (not JSON, not a frame).
      res.write("this is not json at all\n");
      res.write("{not:really}\n");
      res.write('{"kind":"log","chunk":"no-type-field"}\n');
      res.write(
        JSON.stringify({ type: "log", stream: "stderr", chunk: "after\n" }) + "\n",
      );
      res.write(
        JSON.stringify({ type: "done", exitCode: 0, summary: "survived-garbage" }) +
          "\n",
      );
      res.end();
    });
    const captured: { stream: string; chunk: string }[] = [];
    try {
      const outcome = await executeWake(
        makeConfig(url),
        {
          runId: "run-garbage",
          agentId: "a",
          containerId: "c",
          workspacePath: "/w",
          wakePayload: {},
        },
        async (stream, chunk) => {
          captured.push({ stream, chunk });
        },
      );
      expect(outcome.reconnected).toBe(false);
      expect(outcome.done.exitCode).toBe(0);
      expect(outcome.done.summary).toBe("survived-garbage");
      expect(captured).toEqual([
        { stream: "stdout", chunk: "before\n" },
        { stream: "stderr", chunk: "after\n" },
      ]);
    } finally {
      await close();
    }
  });

  it("maps a 401 with a stale timestamp header to daemon_http_error (HMAC skew e2e)", async () => {
    // Simulate a daemon that enforces skew: the daemon checks the timestamp
    // header itself and returns 401 if it drifts too far. We stub the now()
    // dep to produce a timestamp the server will reject.
    const { url, close } = await startServer((req, res) => {
      const ts = Number(req.headers[HMAC_HEADER_TIMESTAMP]);
      const serverNow = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(ts) || Math.abs(serverNow - ts) > 300) {
        res.statusCode = 401;
        res.end("timestamp skew");
        return;
      }
      res.statusCode = 200;
      res.end();
    });
    try {
      const staleNow = () => Date.now() - 10 * 60 * 1000; // 10 min stale
      await expect(
        executeWake(
          makeConfig(url),
          {
            runId: "run-skew",
            agentId: "a",
            containerId: "c",
            workspacePath: "/w",
            wakePayload: {},
          },
          async () => {},
          { now: staleNow },
        ),
      ).rejects.toMatchObject({
        code: "daemon_http_error",
        detail: { status: 401 },
      });
    } finally {
      await close();
    }
  });

  it("propagates poll status:\"error\" → exitCode 1 + errorMessage", async () => {
    const { url, close } = await startServer((req, res) => {
      if (req.url === "/paperclip/wake") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/x-ndjson");
        res.write(
          JSON.stringify({ type: "log", stream: "stdout", chunk: "partial\n" }) +
            "\n",
        );
        res.end(); // no terminal frame
        return;
      }
      if (req.url?.startsWith("/paperclip/runs/")) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            status: "error",
            errorMessage: "container OOM",
            sessionDisplayId: "sess-err",
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    try {
      const outcome = await executeWake(
        {
          ...makeConfig(url),
          graceSec: 0, // skip the grace window so the test runs fast
        },
        {
          runId: "run-err",
          agentId: "a",
          containerId: "c",
          workspacePath: "/w",
          wakePayload: {},
        },
        async () => {},
        { pollIntervalMs: 5, pollMaxIntervalMs: 50 },
      );
      expect(outcome.reconnected).toBe(true);
      expect(outcome.done.exitCode).toBe(1);
      expect(outcome.done.errorMessage).toBe("container OOM");
      expect(outcome.done.sessionDisplayId).toBe("sess-err");
    } finally {
      await close();
    }
  });

  it("applies backpressure on the stream when onLog is slow", async () => {
    // Emit many log chunks rapidly; onLog sleeps per chunk so the for-await
    // loop cannot drain. If backpressure weren't honored, the loop would
    // race ahead of the consumer and we wouldn't see the in-order slow
    // processing pattern.
    const total = 50;
    const { url, close } = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/x-ndjson");
      for (let i = 0; i < total; i += 1) {
        res.write(
          JSON.stringify({
            type: "log",
            stream: "stdout",
            chunk: `line-${i}\n`,
          }) + "\n",
        );
      }
      res.write(JSON.stringify({ type: "done", exitCode: 0 }) + "\n");
      res.end();
    });
    const seen: number[] = [];
    try {
      const outcome = await executeWake(
        makeConfig(url),
        {
          runId: "run-bp",
          agentId: "a",
          containerId: "c",
          workspacePath: "/w",
          wakePayload: {},
        },
        async (_stream, chunk) => {
          const m = /line-(\d+)/.exec(chunk);
          if (m) {
            // Small sleep per chunk — with backpressure, streamFrames awaits
            // this before pulling the next frame, so order must be preserved.
            await new Promise((r) => setTimeout(r, 1));
            seen.push(Number(m[1]));
          }
        },
      );
      expect(outcome.done.exitCode).toBe(0);
      expect(seen.length).toBe(total);
      expect(seen).toEqual(Array.from({ length: total }, (_, i) => i));
    } finally {
      await close();
    }
  });

  it("fails with daemon_stream_error when a single NDJSON line exceeds the buffer cap", async () => {
    // Emit a single line (no newline) larger than 4 MiB to trigger the
    // NdjsonSplitter overflow guard end-to-end through executeWake.
    const { url, close } = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/x-ndjson");
      // 5 MiB of ASCII, no trailing newline — will overflow the 4 MiB cap.
      const big = "x".repeat(5 * 1024 * 1024);
      res.write(big);
      // Don't end right away; give the splitter time to detect overflow.
      setTimeout(() => res.end(), 50);
    });
    try {
      await expect(
        executeWake(
          makeConfig(url),
          {
            runId: "run-oversize",
            agentId: "a",
            containerId: "c",
            workspacePath: "/w",
            wakePayload: {},
          },
          async () => {},
        ),
      ).rejects.toMatchObject({ code: "daemon_stream_error" });
    } finally {
      await close();
    }
  }, 15_000);

  it("aborts promptly when timeoutSec fires mid-poll (cancellation e2e)", async () => {
    // Stream ends with no terminal frame; poll always says "running". The
    // abort fires via timeoutSec and must unwind as poll_timeout, not hang.
    const { url, close } = await startServer((req, res) => {
      if (req.url === "/paperclip/wake") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/x-ndjson");
        res.write(
          JSON.stringify({ type: "log", stream: "stdout", chunk: "x\n" }) + "\n",
        );
        res.end();
        return;
      }
      if (req.url?.startsWith("/paperclip/runs/")) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "running" }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    try {
      const start = Date.now();
      await expect(
        executeWake(
          {
            ...makeConfig(url),
            timeoutSec: 1,
            graceSec: 0,
          },
          {
            runId: "run-abort",
            agentId: "a",
            containerId: "c",
            workspacePath: "/w",
            wakePayload: {},
          },
          async () => {},
          { pollIntervalMs: 10, pollMaxIntervalMs: 50 },
        ),
      ).rejects.toMatchObject({ code: "poll_timeout" });
      // Should unwind within a few seconds, not hang until the old 2s poll.
      expect(Date.now() - start).toBeLessThan(5000);
    } finally {
      await close();
    }
  }, 10_000);
});

describe("parsePollResult", () => {
  it("returns null for non-terminal statuses", () => {
    expect(parsePollResult(JSON.stringify({ status: "running" }))).toBeNull();
    expect(parsePollResult(JSON.stringify({ status: "queued" }))).toBeNull();
  });

  it("returns null for non-JSON bodies", () => {
    expect(parsePollResult("not json at all")).toBeNull();
    expect(parsePollResult("")).toBeNull();
  });

  it("maps status:\"done\" to exitCode 0 when omitted", () => {
    const r = parsePollResult(JSON.stringify({ status: "done", summary: "ok" }));
    expect(r?.exitCode).toBe(0);
    expect(r?.timedOut).toBe(false);
    expect(r?.summary).toBe("ok");
  });

  it("maps status:\"error\" to exitCode 1 with synthetic errorMessage when missing", () => {
    const r = parsePollResult(JSON.stringify({ status: "error" }));
    expect(r?.exitCode).toBe(1);
    expect(r?.errorMessage).toBe("daemon reported error");
  });

  it("preserves explicit exitCode, errorMessage, and timedOut flags", () => {
    const r = parsePollResult(
      JSON.stringify({
        status: "timeout",
        exitCode: 137,
        errorMessage: "walltime exceeded",
      }),
    );
    expect(r?.exitCode).toBe(137);
    expect(r?.timedOut).toBe(true);
    expect(r?.errorMessage).toBe("walltime exceeded");
  });
});
