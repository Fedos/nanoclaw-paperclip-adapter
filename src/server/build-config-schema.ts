import type {
  AdapterConfigSchema,
  ConfigFieldSchema,
} from "@paperclipai/adapter-utils";
import { CONFIG_FIELDS, type ConfigFieldSpec } from "../config-schema.js";

const LABELS: Record<string, string> = {
  daemonUrl: "Daemon URL",
  containerId: "Container ID",
  hmacSecret: "HMAC secret",
  hmacSecretEnv: "HMAC secret env var",
  agentKey: "Agent key",
  timeoutSec: "Timeout (seconds)",
  graceSec: "Grace period (seconds)",
  workspacePath: "Workspace path",
};

const NUMBER_FIELDS = new Set(["timeoutSec", "graceSec"]);
const HMAC_GROUP = "HMAC auth";

function inferType(name: string): ConfigFieldSchema["type"] {
  if (NUMBER_FIELDS.has(name)) return "number";
  return "text";
}

function inferDefault(spec: ConfigFieldSpec): unknown {
  if (spec.default === undefined) return undefined;
  if (NUMBER_FIELDS.has(spec.name)) {
    const n = Number(spec.default);
    return Number.isFinite(n) ? n : spec.default;
  }
  return spec.default;
}

function buildHint(spec: ConfigFieldSpec): string {
  if (spec.requirement === "one-of-secret") {
    return `${spec.description}. One of \`hmacSecret\` or \`hmacSecretEnv\` is required.`;
  }
  return spec.description;
}

function toField(spec: ConfigFieldSpec): ConfigFieldSchema {
  const field: ConfigFieldSchema = {
    key: spec.name,
    label: LABELS[spec.name] ?? spec.name,
    type: inferType(spec.name),
    hint: buildHint(spec),
    required: spec.requirement === "required",
  };
  const def = inferDefault(spec);
  if (def !== undefined) field.default = def;
  if (spec.name === "hmacSecret" || spec.name === "hmacSecretEnv") {
    field.group = HMAC_GROUP;
  }
  if (spec.name === "hmacSecret") {
    field.meta = { secret: true };
  }
  return field;
}

export function buildConfigSchema(): AdapterConfigSchema {
  return {
    fields: CONFIG_FIELDS.map(toField),
  };
}
