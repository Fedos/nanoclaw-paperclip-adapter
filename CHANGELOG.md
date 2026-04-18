# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - Unreleased

### Fixed

- Export `createServerAdapter()` factory from the package entry so the Paperclip plugin-loader can mount the adapter. The previous release exposed only the flat `execute`/`testEnvironment`/`type`/... shape, which tripped `plugin-loader.ts` and broke `Install from npm` in the Paperclip UI.

## [0.1.0] - Unreleased

Initial public release.

### Added

- Paperclip adapter plugin (`type: "nanoclaw"`) that delivers Paperclip wakes to a nanoclaw-managed agent container over signed HTTP and forwards the daemon's NDJSON transcript into the Paperclip run viewer.
- UI transcript parser (`nanoclaw-paperclip-adapter/ui-parser`) that maps nanoclaw NDJSON frames (`log`, `assistant`, `tool_call`, `tool_result`, `done`, ...) into Paperclip `TranscriptEntry` records.
- Config schema, `testEnvironment()` health probe, and reconnect-via-`/paperclip/runs/{runId}` fallback when the wake stream closes before a `done` frame.
- Manual-dispatch `Publish` workflow with version-match gate, provenance, and dry-run support.

### Packaging

- Published as the scoped package `@fury_ios/nanoclaw-paperclip-adapter` with `publishConfig.access=public`.
- Publish workflow uses npm **Trusted Publishing (OIDC)** — no long-lived `NPM_TOKEN` secret; relies on the workflow's `id-token: write` permission plus `npm publish --provenance`.
- Narrowed the public surface to "agent container" wording (README, config schema doc, `package.json` keywords) so the adapter does not advertise a single hard-coded agent runtime.
