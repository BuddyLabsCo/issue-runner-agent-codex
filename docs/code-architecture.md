# Code architecture

Use this map to place enhancement code and tests. Interface behavior belongs in [Core's public integration contract](https://github.com/BuddyLabsCo/issue-runner-core/blob/main/docs/terminal-contract.md); native interactions belong in [Codex protocol](codex-protocol.md).

## Directory map

```text
/
|-- src/
|   |-- index.ts               # Public contractVersion and createEnhancement exports
|   |-- enhancement.ts         # Per-Tab lifecycle assembly and coordinated cleanup
|   |-- config.ts              # Enhancement option validation and defaults
|   |-- diagnostics.ts         # Redacted notices on inherited Runner stderr
|   |-- preflight/             # Effective checkout and hook trust before startup
|   |-- session/               # GUID identification and verified model-start readiness
|   |-- monitor/               # Bound conversation, Assignment, state and reconnection
|   |-- recovery/              # Recovery eligibility, budgets, waits and cancellation
|   `-- codex/                 # Native protocol, Git discovery and portable file I/O
|-- tests/
|   |-- unit/                  # Static architecture and quality rules
|   |-- integration/           # Public lifecycle through injected/native substitutes
|   |-- package/               # Installed exports, runtime isolation and Core types
|   |-- fixtures/              # Bound I/O, controlled clock and native byte bridge
|   `-- release/               # Release scripts through Git/GitHub/npm fixtures
|-- scripts/release/           # Independent candidate and publication tooling
|-- docs/                      # Protocol, architecture and agent instructions
|-- .github/workflows/         # Checks and tests on Ubuntu and Windows
`-- dist/                      # Generated JavaScript and declarations
```

## Module ownership

Keep policy with the feature that owns it; keep native I/O behind `codex/`.

| Owner | Responsibilities |
| --- | --- |
| `index.ts` | Export only `contractVersion = 3` and `createEnhancement`. |
| `enhancement.ts` | Validate configuration, connect, await preflight, assemble per-Tab instances, and expose the five lifecycle methods. Coordinate immediate cancellation and retryable resource cleanup. |
| `config.ts` | Validate shared enhancement options and apply defaults. Configuration-field explanations live in Core's template comments. |
| `preflight/` | Establish and verify primary checkout trust, replacing an explicit `untrusted` value when necessary. Preserve separate distrust overrides for the task cwd or Worktree, disabled hooks, unrelated settings and persisted writes. Trust current hook hashes and verify readback. |
| `session/` | Submit GUID markers through bound I/O, identify the enclosing native conversation, and correlate the bootstrap prompt with its model turn start. Own readiness deadlines and retry evidence. |
| `monitor/` | Bind one exact native ref, retain Assignment ID and expected file together, filter notifications, refresh snapshots and reconnect. Invalidate stale asynchronous observations on replacement, new turns, disconnect and stop. |
| `recovery/` | Decide eligibility from current facts, complete final replies and file presence. Own Assignment Enhancement Pause, processed reply identity, matching resume, separate budgets, delays, cancellation and originating-Assignment rechecks before calling `requestRecovery(id)`. |
| `codex/` | Start/connect to the shared daemon, implement framed WebSocket RPC over the owned proxy, configuration/hook operations, Git checkout discovery and file existence checks. Release only owned connections and proxies. |
| `diagnostics.ts` | Format enhancement notices without native payloads, credentials or transport close reasons. |
| `scripts/release/` | Own release identity, candidate packing and publication recovery independently of enhancement runtime code. |
