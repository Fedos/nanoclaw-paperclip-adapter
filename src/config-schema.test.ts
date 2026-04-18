import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONFIG_FIELDS,
  CONFIG_TABLE_MARKDOWN,
  agentConfigurationDoc,
  renderConfigTable,
} from "./config-schema.js";

describe("config schema", () => {
  it("exposes every documented field", () => {
    const names = CONFIG_FIELDS.map((f) => f.name);
    expect(names).toEqual([
      "daemonUrl",
      "containerId",
      "hmacSecret",
      "hmacSecretEnv",
      "agentKey",
      "timeoutSec",
      "graceSec",
      "workspacePath",
    ]);
  });

  it("rendered table is stable", () => {
    expect(CONFIG_TABLE_MARKDOWN).toBe(renderConfigTable());
    // Row count matches field count + 2 header rows.
    const lines = CONFIG_TABLE_MARKDOWN.split("\n");
    expect(lines.length).toBe(CONFIG_FIELDS.length + 2);
  });

  it("agentConfigurationDoc contains every field name", () => {
    for (const field of CONFIG_FIELDS) {
      expect(agentConfigurationDoc).toContain(`\`${field.name}\``);
    }
  });

  it("README contains the exact generated config table (no drift)", () => {
    const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));
    const readme = readFileSync(readmePath, "utf8");
    const begin = readme.indexOf(
      "<!-- BEGIN:config-table (generated from src/config-schema.ts — do not edit) -->",
    );
    const end = readme.indexOf("<!-- END:config-table -->");
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const block = readme.slice(begin, end);
    expect(block).toContain(CONFIG_TABLE_MARKDOWN);
  });
});
