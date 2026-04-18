import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterModel,
} from "@paperclipai/adapter-utils";
import { resolveConfig } from "./config.js";
import { executeWake, WakeError } from "./wake.js";
import { buildAdapterEnv } from "./env.js";
import { testEnvironment as runTestEnvironment } from "./test-environment.js";
import { agentConfigurationDoc } from "./config-schema.js";

export const type = "nanoclaw";
export const label = "Nanoclaw";
export const models: AdapterModel[] = [];

export { agentConfigurationDoc };

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const resolved = resolveConfig(ctx.agent?.adapterConfig ?? {});
  if (!resolved.ok) {
    const message = resolved.errors
      .map((e) => `${e.field}: ${e.message}`)
      .join("; ");
    await ctx.onLog("stderr", `[nanoclaw] adapter config invalid — ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "config_invalid",
      errorMessage: message,
    };
  }
  const config = resolved.config;
  const taskId =
    typeof ctx.context?.taskId === "string"
      ? (ctx.context.taskId as string)
      : null;
  const env = buildAdapterEnv(ctx.agent, ctx.runId, config, taskId);

  const body = {
    runId: ctx.runId,
    taskId,
    agentId: ctx.agent.id,
    containerId: config.containerId,
    workspacePath: config.workspacePath,
    wakePayload: {
      env,
      config: ctx.config,
      context: ctx.context,
      runtime: ctx.runtime,
    },
    callbackUrl: env.PAPERCLIP_API_URL ?? null,
    callbackJwt: ctx.authToken ?? null,
  };

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: type,
      command: `POST ${config.daemonUrl}/paperclip/wake`,
      env,
      context: {
        containerId: config.containerId,
        workspacePath: config.workspacePath,
        timeoutSec: config.timeoutSec,
      },
    });
  }

  await ctx.onLog(
    "stdout",
    `[nanoclaw] dispatching wake for container=${config.containerId} runId=${ctx.runId}\n`,
  );

  try {
    const outcome = await executeWake(config, body, ctx.onLog);
    const done = outcome.done;
    if (outcome.reconnected) {
      await ctx.onLog(
        "stdout",
        `[nanoclaw] recovered result via status poll (${outcome.pollAttempts} attempts)\n`,
      );
    }
    const result: AdapterExecutionResult = {
      exitCode: done.exitCode,
      signal: done.signal ?? null,
      timedOut: done.timedOut === true,
    };
    if (done.errorMessage) result.errorMessage = done.errorMessage;
    if (done.usage) result.usage = done.usage;
    if (done.sessionParams) result.sessionParams = done.sessionParams;
    if (done.sessionDisplayId) result.sessionDisplayId = done.sessionDisplayId;
    if (done.provider) result.provider = done.provider;
    if (done.model) result.model = done.model;
    if (typeof done.costUsd === "number") result.costUsd = done.costUsd;
    if (done.summary) result.summary = done.summary;
    if (done.resultJson) result.resultJson = done.resultJson;
    return result;
  } catch (err) {
    const wakeErr = err instanceof WakeError ? err : null;
    const message = err instanceof Error ? err.message : String(err);
    await ctx.onLog("stderr", `[nanoclaw] wake failed — ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: wakeErr?.code === "poll_timeout",
      errorCode: wakeErr?.code ?? "daemon_error",
      errorMessage: message,
    };
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  return runTestEnvironment(ctx);
}

export { resolveConfig } from "./config.js";
export type { NanoclawAdapterConfig } from "./config.js";
export { WakeError, parsePollResult } from "./wake.js";
export { CONFIG_FIELDS, CONFIG_TABLE_MARKDOWN } from "./config-schema.js";
export { USER_AGENT, PACKAGE_VERSION } from "./version.js";
