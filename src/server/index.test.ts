import { describe, it, expect } from "vitest";
import * as entry from "../index.js";

describe("createServerAdapter factory", () => {
  it("is exported from the package entry", () => {
    expect(typeof entry.createServerAdapter).toBe("function");
  });

  it("returns a ServerAdapterModule with nanoclaw type and required hooks", () => {
    const mod = entry.createServerAdapter();
    expect(mod.type).toBe("nanoclaw");
    expect(typeof mod.execute).toBe("function");
    expect(typeof mod.testEnvironment).toBe("function");
  });

  it("forwards the implemented optional fields", () => {
    const mod = entry.createServerAdapter();
    expect(Array.isArray(mod.models)).toBe(true);
    expect(typeof mod.agentConfigurationDoc).toBe("string");
    expect(mod.agentConfigurationDoc).toContain("Nanoclaw Adapter Configuration");
  });

  it("exposes getConfigSchema so the Paperclip UI can render the config form", async () => {
    const mod = entry.createServerAdapter();
    expect(typeof mod.getConfigSchema).toBe("function");
    const schema = await mod.getConfigSchema!();
    expect(Array.isArray(schema.fields)).toBe(true);
    expect(schema.fields.length).toBeGreaterThan(0);
    expect(schema.fields.map((f) => f.key)).toContain("daemonUrl");
    expect(schema.fields.map((f) => f.key)).toContain("hmacSecret");
  });
});
