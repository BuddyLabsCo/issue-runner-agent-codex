# Code Architecture

```text
/
|-- src/                       # Public exports and enhancement assembly
|   |-- index.ts               # contractVersion and createEnhancement; Core contract only
|   |-- enhancement.ts         # Per-Tab lifecycle, current assignment and resource cleanup
|   |-- config.ts              # Configuration validation and defaults
|   |-- preflight/             # Primary checkout trust and hook trust
|   |-- session/               # GUID discovery, session binding and input readiness
|   |-- monitor/               # Notifications, latest thread/turn state and reconnection
|   |-- recovery/              # Error/handoff recovery, budgets, waits and cancellation
|   |-- codex/                 # Native Codex configuration, RPC and portable I/O
|   `-- diagnostics.ts         # Terminal errors and recovery-request output
|-- scripts/release/           # Independent stable Release PRs and exact-candidate publication
|-- tests/
|   |-- unit/                  # Configuration, marker matching, recovery rules and static quality checks
|   |-- integration/           # Enhancement lifecycle through injected capabilities and native protocol substitutes
|   |-- release/               # Real Git fixtures and portable GitHub/npm substitutes
|   |-- package/               # Built exports, optional installation and Core contract compatibility
|   `-- fixtures/             # Scripted capabilities, clock and Codex responses; no terminal-plugin dependency
|-- docs/                      # Architecture, decisions and usage
|-- .github/workflows/         # Static checks and tests on Ubuntu and Windows
`-- dist/                      # Generated output
```

```text
index.ts -> enhancement.ts -> preflight/ | session/ | monitor/ | recovery/
                          -> codex/ -> Codex shared daemon
                          # Feature modules share Codex operations and the injected capabilities
                          # config.ts and diagnostics.ts stay independent of lifecycle policy
```

- Public exports: `contractVersion` is `2`; `createEnhancement(io, requestRecovery, context, config)` consumes only type imports from `issue-runner-core/terminal`. Core is a development dependency, with no runtime or peer coupling. No Core workflow internals or terminal-plugin dependencies.
- `enhancement.ts` assembles the private modules and implements the public lifecycle. `preflight/` completes trust before startup; `session/` establishes binding and ready, without business recovery or Assignment creation. Readiness uses only bound `TerminalIO`.
- `monitor/` retains Assignment ID and expected file together, invalidates observations on replacement, and owns native facts and reconnect; `recovery/` decides whether to request recovery from Core, including `[action required]`, excluded errors, separate budgets, waits and cancellation. A fresh Assignment ID resets context even at the same path. Recovery retains the originating Assignment through asynchronous work and dispatches only `requestRecovery(originatingId)` after validity rechecks.
- Keep native protocol and filesystem I/O in `codex/`, without imports from lifecycle or feature modules. Preserve the shared daemon and unrelated sessions. `config.ts` and `diagnostics.ts` do not import feature modules.
- The terminal plugin owns interactive start/resume commands and terminal I/O. Core owns lifecycle orchestration, readiness pause controls, capability revocation, queued stale-input enforcement, recovery wording, handoff acceptance, and tab closure; task handoffs supply PR metadata. A fulfilled recovery callback can be a stale no-op and does not prove native input occurred.
- **OS-bound code is prohibited throughout this repository, including adapters, tests and fixtures.** No platform branches, OS-specific commands, fixed native paths/socket conventions, shell-dependent execution, PTY handling or native key codes. Use portable Node APIs and the injected capabilities; there is no platform-specific adapter exception.
- Keep helpers beside their owner. The tree defines the target layout; add modules when needed, not as empty scaffolding.
- Run `npm run check` for formatting, lint and types; `npm test` verifies the quality rules.
- `scripts/release/` owns proposal eligibility, release identity, candidate packing and publication recovery. It does not import runtime enhancement modules. Release tests substitute external GitHub/npm boundaries without platform exceptions.
