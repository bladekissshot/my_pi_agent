# Changelog

## Unreleased

- Guide projects without Git or an initial commit through repository URL input and a confirmed local baseline before delegation starts.
- Reuse existing remotes/identity, preserve local files while importing remote history, and never push automatically.
- Add `/delegation repo`, cancellation and non-interactive setup guidance, repository tests, and SDK coverage of the setup-to-worker flow.
- Make the SDK fixture acceptance command portable to Windows.

## 0.1.0 - 2026-11-09

- Optional two-model delegation with user-selectable models and per-session opt-in.
- Required immutable task specs, Git worktrees, bounded concurrency, dependency gates and independent checks.
- Main-model acceptance, structured blockers, cancellation and restart recovery.
- Embedded Pi Web task tree with settled tokens, actual models and execution time.
- Unique session-affinity headers for workers; portable local Pi package.
