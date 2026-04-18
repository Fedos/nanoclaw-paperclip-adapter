import { describe, it, expect } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { executeWake, WakeError } from "./wake.js";
import { verifySignature, HMAC_HEADER_SIGNATURE, HMAC_HEADER_TIMESTAMP } from "./hmac.js";
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
});
