# Code Architecture

```text
/
|-- src/                       # Public exports and enhancement assembly
|   |-- index.ts               # contractVersion and createEnhancement; Core contract only
|   |-- enhancement/           # Per-Host lifecycle, GUID readiness, assignments and recovery policy
|   `-- codex/                 # Trust preflight, shared daemon RPC, native events, state reads and diagnostics
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
public module -> enhancement/ -> codex/ -> Codex shared daemon
                           # Host receives terminal input and recovery requests
                           # Native I/O stays in codex/; policy stays in enhancement/
```

- Public exports: `contractVersion` and `createEnhancement`; consume only `issue-runner-core/terminal` contracts. No Core workflow internals or terminal-plugin dependencies.
- `enhancement/` owns one Host/session binding, readiness and the current expectedFile; separate error/handoff budgets, waits, cancellation and `[action required]` handling stay together.
- `codex/` owns portable checkout/hook trust, native RPC/notification decoding, latest-state queries, reconnect and stderr output. Keep the shared daemon and unrelated sessions untouched.
- The terminal plugin owns interactive start/resume commands and terminal I/O. Request recovery through the injected Host; Core owns handoff wording, file acceptance and PR metadata.
- **OS-bound code is prohibited throughout this repository, including adapters, tests and fixtures.** No platform branches, OS-specific commands, fixed native paths/socket conventions, shell-dependent execution, PTY handling or native key codes. Use portable Node APIs and the injected Host; there is no platform-specific adapter exception.
- Keep helpers beside their owner. The tree defines the target layout; add modules when needed, not as empty scaffolding.
- Run `npm run check` for formatting, lint and types; `npm test` verifies the quality rules.
