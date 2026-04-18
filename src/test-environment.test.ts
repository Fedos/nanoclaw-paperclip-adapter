import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { testEnvironment } from "./test-environment.js";

async function withServer(
  status: number,
  body: string,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer((_req, res) => {
    res.statusCode = status;
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;
  try {
    await run(url);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("testEnvironment", () => {
  it("fails fast on invalid config", async () => {
    const result = await testEnvironment({
      companyId: "co",
      adapterType: "nanoclaw",
      config: {},
    });
    expect(result.status).toBe("fail");
    const fields = result.checks.map((c) => c.code);
    expect(fields).toContain("config.daemonUrl");
    expect(fields).toContain("config.containerId");
    expect(fields).toContain("config.hmacSecret");
  });

  it("returns pass when daemon health returns 200", async () => {
    await withServer(200, '{"status":"ok"}', async (url) => {
      const result = await testEnvironment({
        companyId: "co",
        adapterType: "nanoclaw",
        config: {
          daemonUrl: url,
          containerId: "c",
          hmacSecret: "s",
        },
      });
      expect(result.status).toBe("pass");
      expect(result.checks.map((c) => c.code)).toContain("daemon.health");
    });
  });

  it("returns fail when daemon rejects signed request with 401", async () => {
    await withServer(401, "nope", async (url) => {
      const result = await testEnvironment({
        companyId: "co",
        adapterType: "nanoclaw",
        config: {
          daemonUrl: url,
          containerId: "c",
          hmacSecret: "s",
        },
      });
      expect(result.status).toBe("fail");
      expect(result.checks.some((c) => c.code === "daemon.auth")).toBe(true);
    });
  });
});
