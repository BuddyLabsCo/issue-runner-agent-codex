# Code Architecture

```text
/
|-- src/                       # Public exports and enhancement assembly
|   |-- index.ts               # contractVersion and createEnhancement; Core contract only
|   |-- enhancement.ts         # Per-Host lifecycle, current assignment and resource cleanup
|   |-- config.ts              # Configuration validation and defaults
|   |-- preflight/             # Primary checkout trust and hook trust
|   |-- session/               # GUID discovery, session binding and input readiness
|   |-- monitor/               # Notifications, latest thread/turn state and reconnection
|   |-- recovery/              # Error/handoff recovery, budgets, waits and cancellation
|   |-- codex/                 # Native Codex configuration, RPC and portable I/O
|   `-- diagnostics.ts         # Terminal errors and recovery-submission output
|-- tests/
|   |-- unit/                  # Configuration, marker matching, recovery rules and static quality checks
|   |-- integration/           # Enhancement lifecycle through Host and Codex protocol substitutes
|   |-- package/               # Built exports, optional installation and Core contract compatibility
|   `-- fixtures/             # Scripted Host, clock and Codex responses; no terminal-plugin dependency
|-- docs/                      # Architecture, decisions and usage
|-- .github/workflows/         # Static checks and tests on Ubuntu and Windows
`-- dist/                      # Generated output
```

```text
index.ts -> enhancement.ts -> preflight/ | session/ | monitor/ | recovery/
                          -> codex/ -> Codex shared daemon
                          # Feature modules share Codex operations and the injected Host
                          # config.ts and diagnostics.ts stay independent of lifecycle policy
```

- Public exports: `contractVersion` and `createEnhancement`; consume only `issue-runner-core/terminal` contracts. No Core workflow internals or terminal-plugin dependencies.
- `enhancement.ts` assembles the private modules and implements the public lifecycle. `preflight/` completes trust before startup; `session/` establishes binding and ready, without business recovery.
- `monitor/` reports current facts and owns reconnect; `recovery/` decides whether to request Host recovery, including `[action required]`, excluded errors, separate budgets, waits and cancellation.
- Keep native protocol and filesystem I/O in `codex/`, without imports from lifecycle or feature modules. Preserve the shared daemon and unrelated sessions. `config.ts` and `diagnostics.ts` do not import feature modules.
- The terminal plugin owns interactive start/resume commands and terminal I/O. Core owns handoff wording and acceptance; task handoffs supply PR metadata.
- **OS-bound code is prohibited throughout this repository, including adapters, tests and fixtures.** No platform branches, OS-specific commands, fixed native paths/socket conventions, shell-dependent execution, PTY handling or native key codes. Use portable Node APIs and the injected Host; there is no platform-specific adapter exception.
- Keep helpers beside their owner. The tree defines the target layout; add modules when needed, not as empty scaffolding.
- Run `npm run check` for formatting, lint and types; `npm test` verifies the quality rules.
