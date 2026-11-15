# Repository instructions

This is a personal monorepo containing two Git subtrees and reusable plugins.

- Read the instructions in each subtree before changing its code.
- Keep Pi and Pi Web changes in their respective `projects/` directories; isolate reusable functionality under `plugins/`.
- Keep each upstream's package manager and build layout. Do not run upstream release or publication commands as a local build step.
- Pi Web and plugin SDK tests must use the local Pi packages after `build:pi` links them.
- Use Node.js 24 or newer, including npm's child processes.
- Never commit runtime catalogs, sessions, credentials, provider endpoint configuration, `.local/`, build output or node_modules.
- Run `npm run audit:public` before pushing. A local audit may also accept `--private-dir <agent-directory>` to check exact private values without printing them.
- Sync one upstream at a time with the root synchronization script. Resolve conflicts and run relevant checks before integrating its branch.
- Do not force-push or automatically push synchronization branches.

The human's task instructions and authorization take precedence over imported upstream contribution policies.
