import { request } from "undici";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentTestStatus,
} from "@paperclipai/adapter-utils";
import { resolveConfig } from "./config.js";
import { HMAC_HEADER_SIGNATURE, HMAC_HEADER_TIMESTAMP, signPayload } from "./hmac.js";

export interface TestEnvironmentDeps {
  request?: typeof request;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

const ADAPTER_TYPE = "nanoclaw";

function pickWorst(
  current: AdapterEnvironmentTestStatus,
  level: "info" | "warn" | "error",
): AdapterEnvironmentTestStatus {
  if (level === "error") return "fail";
  if (level === "warn" && current === "pass") return "warn";
  return current;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
  deps: TestEnvironmentDeps = {},
): Promise<AdapterEnvironmentTestResult> {
  const doRequest = deps.request ?? request;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const checks: AdapterEnvironmentCheck[] = [];
  let status: AdapterEnvironmentTestStatus = "pass";

  const resolved = resolveConfig(ctx.config, env);
  if (!resolved.ok) {
    for (const err of resolved.errors) {
      checks.push({
        code: `config.${err.field}`,
        level: "error",
        message: err.message,
      });
    }
    return {
      adapterType: ADAPTER_TYPE,
      status: "fail",
      checks,
      testedAt: new Date(now()).toISOString(),
    };
  }

  const { config } = resolved;
  checks.push({
    code: "config.resolved",
    level: "info",
    message: `daemonUrl=${config.daemonUrl} container=${config.containerId}`,
  });

  const body = "";
  try {
    const res = await doRequest(`${config.daemonUrl}/paperclip/health`, {
      method: "GET",
      headers: {
        "user-agent": "nanoclaw-paperclip-adapter/0.1.0",
        [HMAC_HEADER_TIMESTAMP]: signPayload(config.hmacSecret, body, now).timestamp,
        [HMAC_HEADER_SIGNATURE]: signPayload(config.hmacSecret, body, now).signature,
      },
      headersTimeout: 5000,
    });
    if (res.statusCode === 401 || res.statusCode === 403) {
      checks.push({
        code: "daemon.auth",
        level: "error",
        message: `daemon rejected signed health request (HTTP ${res.statusCode}) — check hmacSecret`,
      });
      status = pickWorst(status, "error");
    } else if (res.statusCode >= 200 && res.statusCode < 300) {
      const text = await res.body.text();
      checks.push({
        code: "daemon.health",
        level: "info",
        message: `daemon healthy (HTTP ${res.statusCode})`,
        detail: text.slice(0, 200) || null,
      });
    } else {
      await res.body.text().catch(() => "");
      checks.push({
        code: "daemon.health",
        level: "warn",
        message: `daemon returned HTTP ${res.statusCode} for /paperclip/health`,
      });
      status = pickWorst(status, "warn");
    }
  } catch (err) {
    checks.push({
      code: "daemon.unreachable",
      level: "error",
      message: `daemon unreachable at ${config.daemonUrl}: ${(err as Error).message}`,
    });
    status = pickWorst(status, "error");
  }

  return {
    adapterType: ADAPTER_TYPE,
    status,
    checks,
    testedAt: new Date(now()).toISOString(),
  };
}
