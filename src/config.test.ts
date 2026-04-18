import { describe, it, expect } from "vitest";
import { resolveConfig, DEFAULT_TIMEOUT_SEC, DEFAULT_GRACE_SEC, DEFAULT_WORKSPACE_PATH } from "./config.js";

describe("resolveConfig", () => {
  it("fills defaults when minimum fields are supplied", () => {
    const r = resolveConfig({
      daemonUrl: "http://127.0.0.1:18789/",
      containerId: "c1",
      hmacSecret: "s",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.daemonUrl).toBe("http://127.0.0.1:18789");
    expect(r.config.timeoutSec).toBe(DEFAULT_TIMEOUT_SEC);
    expect(r.config.graceSec).toBe(DEFAULT_GRACE_SEC);
    expect(r.config.workspacePath).toBe(DEFAULT_WORKSPACE_PATH);
  });

  it("resolves secret from an env var reference", () => {
    const r = resolveConfig(
      {
        daemonUrl: "http://127.0.0.1:18789",
        containerId: "c1",
        hmacSecretEnv: "NANOCLAW_SECRET",
      },
      { NANOCLAW_SECRET: "super-secret" } as NodeJS.ProcessEnv,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.hmacSecret).toBe("super-secret");
    expect(r.config.hmacSecretEnvVar).toBe("NANOCLAW_SECRET");
  });

  it("reports every missing field", () => {
    const r = resolveConfig({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const fields = r.errors.map((e) => e.field).sort();
    expect(fields).toEqual(["containerId", "daemonUrl", "hmacSecret"].sort());
  });

  it("rejects a non-http daemonUrl", () => {
    const r = resolveConfig({
      daemonUrl: "file:///tmp/x",
      containerId: "c1",
      hmacSecret: "s",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]?.field).toBe("daemonUrl");
  });

  it("errors when referenced env var is empty", () => {
    const r = resolveConfig(
      {
        daemonUrl: "http://127.0.0.1",
        containerId: "c1",
        hmacSecretEnv: "MISSING",
      },
      {} as NodeJS.ProcessEnv,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]?.field).toBe("hmacSecret");
  });
});
