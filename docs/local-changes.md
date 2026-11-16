# Migrated local changes

- Prompt-manager plugin: template CRUD, default selection, immutable per-session text/version snapshots, legacy recovery, concurrent first-writer-wins binding and CLI commands.
- Pi Web: System tab management, shared plugin API, creation-time prompt binding, root/session resource-loader overrides, localization and relevant tests.
- Default Web workspace: optional `PI_WEB_DEFAULT_CWD_ROOT` controls the daily workspace root and seeds the existing allowed-root registry. No machine path is embedded in the source.
- Windows desktop launcher: `scripts/Start-PiWeb.ps1` checks the local TCP listener table before HTTP readiness probes, avoids CIM port enumeration, polls every 100ms and reuses the successful page check. Installation paths are configurable; service reuse, startup serialization and occupied-port protection have isolated Windows integration tests. See [desktop launcher usage](windows-desktop-launcher.md).
- Delegation plugin: current optional two-model workflow, immutable specs, isolated worktrees, repository initialization dialog, validation and main-model acceptance, including local uncommitted changes at import time.
- Pi source: the complete reviewed v1.5.0 upstream toolkit, with no direct local core edits at this import.

Runtime settings, authentication, provider catalogs, API endpoints, session transcripts, prompt catalogs and bound snapshots are not migrated into Git. The example provider configuration uses a non-routable placeholder host and an environment-variable reference.

The previous working directories and live installation are preserved. Deployment is explicit: build from this checkout and launch with an ignored local configuration. This import does not restart or replace a running agent.
