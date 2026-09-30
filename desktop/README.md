# Archivist desktop application

Electron desktop application for a local-first physical-media catalogue. The renderer uses a typed preload API; catalogue persistence and filesystem operations remain in the main process.

## Requirements and development

Use Node.js 24 and npm 11. From this directory:

```sh
npm ci
npm run verify
npm run start
```

`npm run verify` runs the TypeScript check and automated tests. The catalogue uses SQLite in the app's local data directory. Integrations and metadata-provider lookup are not production-ready; use synthetic data for development.

## Current scope

The desktop slice includes local Work/Edition/owned-copy records for film, television, music, and games; search and filters; statistics; durable change history; and bounded backup/restore for the current schema. Backup/restore is not yet a cross-platform recovery guarantee. Windows/Linux runtime and installer validation, full accessibility review, broader migration/crash coverage, and product acceptance remain open.

## Packaging and smoke test

Build a macOS arm64 package, then run its synthetic packaged IPC smoke:

```sh
npm run package -- --arch=arm64
npm run smoke:catalogue:package
```

The smoke verifies the packaged native SQLite module, trusted renderer IPC, denial of an untrusted renderer, and replay after restart. It is not a release-readiness test.

Third-party component provenance and notices are recorded in [`notices/prototype-third-party-notices.md`](notices/prototype-third-party-notices.md). No application license file is included in this snapshot.
