# Migrated local changes

- Prompt-manager plugin: template CRUD, default selection, immutable per-session text/version snapshots, legacy recovery, concurrent first-writer-wins binding and CLI commands.
- Pi Web: System tab management, shared plugin API, creation-time prompt binding, root/session resource-loader overrides, localization and relevant tests.
- Default Web workspace: optional `PI_WEB_DEFAULT_CWD_ROOT` controls the daily workspace root and seeds the existing allowed-root registry. No machine path is embedded in the source.
- Windows desktop launcher: `scripts/Start-PiWeb.ps1` checks the local TCP listener table before HTTP readiness probes, avoids CIM port enumeration, polls every 100ms and reuses the successful page check. Installation paths are configurable; service reuse, startup serialization and occupied-port protection have isolated Windows integration tests. See [desktop launcher usage](windows-desktop-launcher.md).
- Delegation plugin: current optional two-model workflow, immutable specs, isolated worktrees, repository initialization dialog, validation and main-model acceptance, including local uncommitted changes at import time.
- Streaming rendering: coalesce text, thinking and tool-input UI notifications in 50ms windows without dropping content; complete and reconnect synchronously. Follow scrolling after the rendered batch commits. Unit tests and a model-free browser benchmark cover burst rendering, paused output, reading position and completion.
- Linked SDK builds: explicitly preserve native ESM imports for the configured local Pi runtimes and their subpath exports on the server; Next's node_modules-path external detection otherwise bundles monorepo junction targets and breaks SDK dynamic imports. Browser helpers remain bundled.
- Pi source: the complete reviewed v1.5.0 upstream toolkit, with no direct local core edits at this import.

Runtime settings, authentication, provider catalogs, API endpoints, session transcripts, prompt catalogs and bound snapshots are not migrated into Git. The example provider configuration uses a non-routable placeholder host and an environment-variable reference.

The previous working directories and live installation are preserved. Deployment is explicit: build from this checkout and launch with an ignored local configuration. This import does not restart or replace a running agent.
