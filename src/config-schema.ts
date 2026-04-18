/**
 * Canonical schema for this adapter's user-visible config.
 *
 * Single source of truth for:
 *   - {@link agentConfigurationDoc} returned from the adapter entrypoint
 *   - the README config table (kept in sync via `config-schema.test.ts`)
 *
 * If you change a field here, re-run `npm test` — the README sync test will
 * fail until you update the table in README.md to match.
 */

export type ConfigFieldRequirement = "required" | "one-of-secret" | "optional";

export interface ConfigFieldSpec {
  name: string;
  requirement: ConfigFieldRequirement;
  default?: string;
  description: string;
}

export const CONFIG_FIELDS: readonly ConfigFieldSpec[] = [
  {
    name: "daemonUrl",
    requirement: "required",
    description: "`http(s)://` base URL of the nanoclaw daemon",
  },
  {
    name: "containerId",
    requirement: "required",
    description:
      "Which nanoclaw container/agent key this Paperclip agent maps to",
  },
  {
    name: "hmacSecret",
    requirement: "one-of-secret",
    description:
      "HMAC shared secret (literal). Strongly prefer `hmacSecretEnv` so the secret is not persisted",
  },
  {
    name: "hmacSecretEnv",
    requirement: "one-of-secret",
    description:
      "Name of the env var on the Paperclip server that holds the HMAC secret",
  },
  {
    name: "agentKey",
    requirement: "optional",
    description:
      "Optional alias, forwarded to the daemon as `NANOCLAW_AGENT_KEY`",
  },
  {
    name: "timeoutSec",
    requirement: "optional",
    default: "1800",
    description: "Hard wake timeout in seconds",
  },
  {
    name: "graceSec",
    requirement: "optional",
    default: "30",
    description: "Grace period before treating a disconnect as failure",
  },
  {
    name: "workspacePath",
    requirement: "optional",
    default: "/workspace/group",
    description: "Container path nanoclaw mounts for this agent's workspace",
  },
] as const;

function renderRequirement(req: ConfigFieldRequirement): string {
  switch (req) {
    case "required":
      return "yes";
    case "one-of-secret":
      return "one of";
    case "optional":
      return "no";
  }
}

/**
 * Render the shared config table as GitHub-flavored markdown. The output is
 * used verbatim in both `agentConfigurationDoc` and the README, so the two
 * cannot drift.
 */
export function renderConfigTable(): string {
  const header =
    "| Field            | Required | Default             | Description                                                                                  |\n" +
    "| ---------------- | -------- | ------------------- | -------------------------------------------------------------------------------------------- |";
  const rows = CONFIG_FIELDS.map((f) => {
    const name = `\`${f.name}\``;
    const req = renderRequirement(f.requirement);
    const def = f.default ? `\`${f.default}\`` : "—";
    return `| ${name.padEnd(16)} | ${req.padEnd(8)} | ${def.padEnd(19)} | ${f.description} |`;
  });
  return [header, ...rows].join("\n");
}

export const CONFIG_TABLE_MARKDOWN = renderConfigTable();

export const agentConfigurationDoc = `# Nanoclaw Adapter Configuration

Runs a nanoclaw-managed Claude Code container as a Paperclip employee. Each
heartbeat is delivered to the nanoclaw daemon over a signed HTTP call and its
NDJSON output is streamed back into the Paperclip run UI.

## Fields

${CONFIG_TABLE_MARKDOWN}

You **must** also set the env var referenced by \`hmacSecretEnv\` on the
Paperclip server (so the adapter can sign requests) and on the nanoclaw
daemon (so it can verify them).

See the package README for the full daemon protocol (endpoints, HMAC headers,
and frame format).
`;
