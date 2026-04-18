export interface NanoclawAdapterConfig {
  daemonUrl: string;
  containerId: string;
  agentKey?: string;
  hmacSecret: string;
  hmacSecretEnvVar?: string;
  timeoutSec: number;
  graceSec: number;
  workspacePath: string;
}

export interface ConfigResolutionError {
  field: string;
  message: string;
}

export interface ResolvedConfig {
  ok: true;
  config: NanoclawAdapterConfig;
}

export interface FailedConfig {
  ok: false;
  errors: ConfigResolutionError[];
}

export const DEFAULT_TIMEOUT_SEC = 1800;
export const DEFAULT_GRACE_SEC = 30;
export const DEFAULT_WORKSPACE_PATH = "/workspace/group";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function resolveSecret(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): { value?: string; envVar?: string; error?: ConfigResolutionError } {
  const envVar = asString(raw.hmacSecretEnv) ?? asString(raw.hmacSecretEnvVar);
  if (envVar) {
    const fromEnv = env[envVar];
    if (!fromEnv) {
      return {
        envVar,
        error: {
          field: "hmacSecret",
          message: `env var "${envVar}" is empty or not set`,
        },
      };
    }
    return { value: fromEnv, envVar };
  }
  const literal = asString(raw.hmacSecret);
  if (!literal) {
    return {
      error: {
        field: "hmacSecret",
        message:
          "hmacSecret is required — provide it as a literal value or via hmacSecretEnv",
      },
    };
  }
  return { value: literal };
}

export function resolveConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig | FailedConfig {
  const errors: ConfigResolutionError[] = [];
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const daemonUrl = asString(obj.daemonUrl);
  if (!daemonUrl) {
    errors.push({ field: "daemonUrl", message: "daemonUrl is required" });
  } else {
    try {
      const parsed = new URL(daemonUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        errors.push({
          field: "daemonUrl",
          message: "daemonUrl must be an http:// or https:// URL",
        });
      }
    } catch {
      errors.push({ field: "daemonUrl", message: "daemonUrl is not a valid URL" });
    }
  }

  const containerId = asString(obj.containerId) ?? asString(obj.agentKey);
  if (!containerId) {
    errors.push({
      field: "containerId",
      message: "containerId (or agentKey) is required",
    });
  }

  const secret = resolveSecret(obj, env);
  if (secret.error) errors.push(secret.error);

  if (errors.length > 0 || !daemonUrl || !containerId || !secret.value) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: {
      daemonUrl: daemonUrl.replace(/\/+$/, ""),
      containerId,
      agentKey: asString(obj.agentKey),
      hmacSecret: secret.value,
      hmacSecretEnvVar: secret.envVar,
      timeoutSec: asNumber(obj.timeoutSec) ?? DEFAULT_TIMEOUT_SEC,
      graceSec: asNumber(obj.graceSec) ?? DEFAULT_GRACE_SEC,
      workspacePath: asString(obj.workspacePath) ?? DEFAULT_WORKSPACE_PATH,
    },
  };
}
