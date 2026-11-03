# issue-runner-agent-codex

Optional, terminal-independent Codex enhancement for Issue Runner.

This repository currently contains agent instructions, the target architecture and static quality checks. The enhancement runtime and package exports are not implemented.

See [code architecture](docs/code-architecture.md) and the [accepted design](https://github.com/BuddyLabsCo/issue-runner-core/issues/190#issuecomment-6604835100).

```sh
npm ci
npm run check
npm test
```

CI runs these checks on Ubuntu and Windows. OS-bound code is prohibited, including in tests and fixtures.
