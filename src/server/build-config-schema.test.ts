import { describe, it, expect } from "vitest";
import { buildConfigSchema } from "./build-config-schema.js";
import { CONFIG_FIELDS } from "../config-schema.js";

describe("buildConfigSchema", () => {
  it("returns one field per CONFIG_FIELDS entry", () => {
    const schema = buildConfigSchema();
    expect(schema.fields).toHaveLength(CONFIG_FIELDS.length);
    expect(schema.fields.map((f) => f.key)).toEqual(
      CONFIG_FIELDS.map((f) => f.name),
    );
  });

  it("maps `required` requirement to required:true", () => {
    const schema = buildConfigSchema();
    const daemonUrl = schema.fields.find((f) => f.key === "daemonUrl");
    const containerId = schema.fields.find((f) => f.key === "containerId");
    expect(daemonUrl?.required).toBe(true);
    expect(containerId?.required).toBe(true);
  });

  it("maps `one-of-secret` to required:false with a clarifying hint and HMAC group", () => {
    const schema = buildConfigSchema();
    const hmacSecret = schema.fields.find((f) => f.key === "hmacSecret");
    const hmacSecretEnv = schema.fields.find((f) => f.key === "hmacSecretEnv");
    expect(hmacSecret?.required).toBe(false);
    expect(hmacSecretEnv?.required).toBe(false);
    expect(hmacSecret?.hint).toMatch(/One of.*hmacSecret.*hmacSecretEnv/);
    expect(hmacSecretEnv?.hint).toMatch(/One of.*hmacSecret.*hmacSecretEnv/);
    expect(hmacSecret?.group).toBe("HMAC auth");
    expect(hmacSecretEnv?.group).toBe("HMAC auth");
  });

  it("maps `optional` to required:false", () => {
    const schema = buildConfigSchema();
    for (const key of [
      "agentKey",
      "timeoutSec",
      "graceSec",
      "workspacePath",
    ]) {
      expect(schema.fields.find((f) => f.key === key)?.required).toBe(false);
    }
  });

  it("renders timeoutSec/graceSec as number inputs with numeric defaults", () => {
    const schema = buildConfigSchema();
    const timeout = schema.fields.find((f) => f.key === "timeoutSec");
    const grace = schema.fields.find((f) => f.key === "graceSec");
    expect(timeout?.type).toBe("number");
    expect(grace?.type).toBe("number");
    expect(timeout?.default).toBe(1800);
    expect(grace?.default).toBe(30);
  });

  it("marks hmacSecret as secret via meta and keeps hmacSecretEnv plain", () => {
    const schema = buildConfigSchema();
    const hmacSecret = schema.fields.find((f) => f.key === "hmacSecret");
    const hmacSecretEnv = schema.fields.find((f) => f.key === "hmacSecretEnv");
    expect(hmacSecret?.type).toBe("text");
    expect(hmacSecret?.meta).toEqual({ secret: true });
    expect(hmacSecretEnv?.type).toBe("text");
    expect(hmacSecretEnv?.meta).toBeUndefined();
  });

  it("forwards workspacePath default as a string", () => {
    const schema = buildConfigSchema();
    const workspace = schema.fields.find((f) => f.key === "workspacePath");
    expect(workspace?.default).toBe("/workspace/group");
  });

  it("labels (snapshot so UI copy does not silently drift)", () => {
    const schema = buildConfigSchema();
    const labels = Object.fromEntries(
      schema.fields.map((f) => [f.key, f.label]),
    );
    expect(labels).toMatchInlineSnapshot(`
      {
        "agentKey": "Agent key",
        "containerId": "Container ID",
        "daemonUrl": "Daemon URL",
        "graceSec": "Grace period (seconds)",
        "hmacSecret": "HMAC secret",
        "hmacSecretEnv": "HMAC secret env var",
        "timeoutSec": "Timeout (seconds)",
        "workspacePath": "Workspace path",
      }
    `);
  });
});
