# Archivist

Archivist is a local-first desktop catalogue for physical films, television, music, and games.

## Status

Early development. The desktop app includes an offline catalogue, copy-level details, statistics, change history, and backup/restore foundations. Provider integrations, broader recovery coverage, accessibility review, and non-macOS packaging remain incomplete. This is not a production release.

## Development

Requirements: Node.js 24 and npm 11. From `desktop/`:

```sh
npm ci
npm run verify
npm run start
```

For an isolated macOS arm64 package and packaged IPC smoke:

```sh
npm run package -- --arch=arm64
npm run smoke:catalogue:package
```

See [the desktop guide](desktop/README.md) for architecture, test, and packaging details.
