import { buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";
import type { AdapterAgent } from "@paperclipai/adapter-utils";
import type { NanoclawAdapterConfig } from "./config.js";

/**
 * Build the environment variables forwarded to nanoclaw in the wake callback.
 * The daemon receives these over the HTTP body, not the process env — but the
 * shape matches what a child-process adapter would set so nanoclaw can
 * re-export them verbatim inside the container.
 */
export function buildAdapterEnv(
  agent: AdapterAgent,
  runId: string,
  config: NanoclawAdapterConfig,
  taskId?: string | null,
): Record<string, string> {
  const base = buildPaperclipEnv(agent);
  const env: Record<string, string> = {
    ...base,
    PAPERCLIP_RUN_ID: runId,
    NANOCLAW_CONTAINER_ID: config.containerId,
    NANOCLAW_WORKSPACE_PATH: config.workspacePath,
  };
  if (config.agentKey) env.NANOCLAW_AGENT_KEY = config.agentKey;
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  return env;
}
