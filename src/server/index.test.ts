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
});
