# nanoclaw-paperclip-adapter

Paperclip adapter plugin that lets a [nanoclaw](https://github.com/uniclawassistant/nanoclaw)-managed Claude Code container run as a first-class employee in a Paperclip company.

Each Paperclip heartbeat becomes a signed HTTP call to the nanoclaw daemon. The daemon streams NDJSON back while the wake executes; the plugin forwards those frames into the Paperclip run viewer and, on disconnect, falls back to polling the daemon's status endpoint until the run reaches a terminal state.

## Status

Alpha. Pins `@paperclipai/adapter-utils` 2026.325.x, requires Node ≥ 20.

### `@paperclipai/adapter-utils` placement

This package currently declares `@paperclipai/adapter-utils` as a regular
`dependency` (not a `peerDependency`). The Paperclip plugin loader installs
adapter packages into an isolated directory and imports them from there, so a
bundled copy is the behavior the loader expects today. If the published
Paperclip SDK later documents a canonical peer-dep convention for adapters,
we will flip this to `peerDependencies` in a follow-up minor — type shapes
are stable enough that a downstream dedupe is safe either way.

## Install

On the Paperclip instance that will host the adapter:

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/adapters" \
  -d '{"packageName":"nanoclaw-paperclip-adapter"}'
```

Paperclip will fetch the latest published version from the public npm registry and load it as `type: "nanoclaw"`.

## Configure an agent

Create (or update) a Paperclip agent with `adapterType: "nanoclaw"` and an `adapterConfig` like:

```json
{
  "daemonUrl": "http://127.0.0.1:18789",
  "containerId": "unic-main",
  "hmacSecretEnv": "NANOCLAW_HMAC_SECRET",
  "timeoutSec": 1800,
  "graceSec": 30,
  "workspacePath": "/workspace/group"
}
```

<!-- BEGIN:config-table (generated from src/config-schema.ts — do not edit) -->
| Field            | Required | Default             | Description                                                                                  |
| ---------------- | -------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `daemonUrl`      | yes      | —                   | `http(s)://` base URL of the nanoclaw daemon |
| `containerId`    | yes      | —                   | Which nanoclaw container/agent key this Paperclip agent maps to |
| `hmacSecret`     | one of   | —                   | HMAC shared secret (literal). Strongly prefer `hmacSecretEnv` so the secret is not persisted |
| `hmacSecretEnv`  | one of   | —                   | Name of the env var on the Paperclip server that holds the HMAC secret |
| `agentKey`       | no       | —                   | Optional alias, forwarded to the daemon as `NANOCLAW_AGENT_KEY` |
| `timeoutSec`     | no       | `1800`              | Hard wake timeout in seconds |
| `graceSec`       | no       | `30`                | Grace period before treating a disconnect as failure |
| `workspacePath`  | no       | `/workspace/group`  | Container path nanoclaw mounts for this agent's workspace |
<!-- END:config-table -->

You **must** also set the env var referenced by `hmacSecretEnv` on the Paperclip server (so the adapter can sign requests) and on the nanoclaw daemon (so it can verify them).

## Daemon contract

The plugin talks to two endpoints on the nanoclaw daemon:

### `POST {daemonUrl}/paperclip/wake`

Body (JSON):

```json
{
  "runId": "run-...",
  "taskId": "issue-... | null",
  "agentId": "agent-...",
  "containerId": "unic-main",
  "workspacePath": "/workspace/group",
  "wakePayload": {
    "env": { "PAPERCLIP_AGENT_ID": "...", "PAPERCLIP_API_URL": "...", "PAPERCLIP_RUN_ID": "...", "NANOCLAW_CONTAINER_ID": "...", "NANOCLAW_WORKSPACE_PATH": "..." },
    "config": {},
    "context": {},
    "runtime": {}
  },
  "callbackUrl": "http://.../api",
  "callbackJwt": "<run-scoped JWT>"
}
```

Headers:

- `content-type: application/json`
- `x-paperclip-timestamp: <unix-seconds>`
- `x-paperclip-signature: <hex hmac-sha256 of "${timestamp}.${body}">`
- `user-agent: nanoclaw-paperclip-adapter/<version>`

Response: `200 OK` with `content-type: application/x-ndjson`. The daemon streams one JSON object per line until the wake completes:

```
{"type":"log","stream":"stdout","chunk":"..."}
{"type":"log","stream":"stderr","chunk":"..."}
{"type":"assistant","text":"...","delta":false}
{"type":"tool_call","name":"bash","input":{...},"toolUseId":"..."}
{"type":"tool_result","toolUseId":"...","content":"...","isError":false}
{"type":"done","exitCode":0,"usage":{"inputTokens":0,"outputTokens":0},"summary":"...","sessionParams":{...}}
```

The plugin treats the first `type: "done"` frame as terminal. Unknown frame types are forwarded verbatim as raw stdout to avoid dropping data.

### `GET {daemonUrl}/paperclip/runs/{runId}`

Idempotent status lookup used as a reconnect fallback if the wake stream closes before a `done` frame. Must return JSON:

```json
{
  "status": "running | done | error | timeout",
  "exitCode": 0,
  "summary": "...",
  "sessionParams": { ... },
  "sessionDisplayId": "..."
}
```

Same HMAC headers as `/paperclip/wake` (signed body is empty).

### `GET {daemonUrl}/paperclip/health`

Used by `testEnvironment()`. Return `200` with any JSON body once the daemon is ready to accept wakes. Signature verification is optional but recommended — the adapter sends signed headers so the daemon can reject unauthorized probes.

## UI transcript parser

Paperclip's run viewer loads `nanoclaw-paperclip-adapter/ui-parser` in a browser context. `createStdoutParser().parseLine(line, ts)` maps the NDJSON frames above into Paperclip `TranscriptEntry` records so tool calls, assistant text, and system notices render as proper cards instead of raw stdout. Non-JSON lines fall back to `kind: "stdout"`; `[nanoclaw] ...` system lines become `kind: "system"`.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

Tests run entirely against an in-process `node:http` server, so no nanoclaw daemon is required for the unit + smoke suite.

## Publishing

The `Publish` GitHub Actions workflow is manual-only (`workflow_dispatch`). The workflow requires a `version` input that **must** exactly match the `version` field in `package.json`; the job fails fast before `npm publish` if they disagree, which prevents accidentally publishing the wrong tag.

It runs the full test + build matrix, then publishes to the public npm registry with provenance. Use `dryRun: "true"` to run the same gate without actually publishing. **First publish requires `@Unic sign-off:` on the parent Paperclip issue** — do not dispatch without it.

## License

MIT — see [LICENSE](./LICENSE).
