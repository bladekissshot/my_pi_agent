# my_pi_agent

A personal Pi + Pi Web monorepo with independently tracked upstreams and isolated plugins.

- `projects/pi/`: the complete Pi upstream toolkit.
- `projects/pi-web/`: Pi Web and local UI/runtime integrations.
- `plugins/`: independently reusable Pi packages.
- `scripts/`: upstream synchronization, verification and local build orchestration.
- `upstreams.lock.json`: reviewed upstream versions and commits.

Credentials, provider endpoints, sessions and deployment-specific configuration are kept outside this repository.
