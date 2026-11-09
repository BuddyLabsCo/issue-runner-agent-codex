# issue-runner-agent-codex

Optional Codex enhancement for [issue-runner-core](https://github.com/BuddyLabsCo/issue-runner-core). It prepares checkout and hook trust, verifies startup readiness, observes the exact native conversation, and requests bounded recovery for failed turns or missing handoffs.

## Prerequisites

Need to specify `--remote unix://` on both start and resume. See [Core's Codex connection guidance](https://github.com/BuddyLabsCo/issue-runner-core#codex-enhancement-requires---remote-unix).

Follow [Core prerequisites](https://github.com/BuddyLabsCo/issue-runner-core#prerequisites) for the terminal command, Git/GitHub setup, Agent permissions, and handoff skill.

## Getting started

Install the enhancement in the **same global npm prefix as your terminal command**.

```sh
npm install --global issue-runner-agent-codex # Install the optional enhancement
```

Core discovers `issue-runner-agent-codex` for roles whose Agent identifier is `codex`; no separate activation command is needed. 

See [template comments](https://github.com/BuddyLabsCo/issue-runner-core/blob/main/templates/config.yaml) for supported configuration fields.

## Runtime notices and troubleshooting

One Runner CLI invocation shares a JSONL log sequence across its Codex enhancements.  

Set `terminalPlugins.enhancements.logLevel` to `info` or `error` (default). `error` records failures, including invalid configuration. `info` also records enhancement-owned operation attempts and planned waits, including cancellations and timeouts. 

Enhancement notices use inherited Runner stderr and include `[codex] sessionref=<ref>` (`unbound` before identification):

| Notice | Meaning and response |
| --- | --- |
| `recovery=error attempt=1/3` | A final failed turn qualifies for an automatic recovery request. Native retries and active conversations suppress requests. Core owns the continuation input. |
| `recovery=missing-handoff attempt=1/3` | A completed or interrupted turn is idle without its expected handoff. Recovery waits before every request and rechecks native state and file presence. |
| `ACTION REQUIRED!!!` | The latest final reply starts with literal `[action required]`, allowing leading whitespace. Missing-handoff recovery pauses; inspect the conversation and resolve the requested action. |
| `recovery=error excluded=<classification>` | A budget, usage, authentication, model, context, or policy error needs attention instead of automatic recovery. |
| `recovery=<category> exhausted=3/3` | That Assignment's recovery budget is exhausted. Observation continues; inspect the conversation before continuing manually. Error and missing-handoff budgets are separate. |
| `observation disconnected` / `observation reconnect failed` | Recovery pauses while observation is unavailable. The enhancement retries every ten seconds without restarting Codex or the shared daemon. |
| `recovery operation failed` | A native refresh, file check, or Core recovery callback failed. Inspect the shared Codex log. A failed check skips that action; fresh observations or Assignments can recover. Core input failures still propagate. |
| `hook preflight failed` | Hook inventory, trust repair, or verification failed. Startup continues if native readiness can complete. |
| `monitoring operation failed` / `assignment operation failed` / `cleanup operation failed` | Inspect the shared Codex log. After readiness succeeds, enhancement failures do not interrupt Runner. Cleanup remains bounded and repeatable. |
| `initialization cleanup failed` / `readiness input failed` | An owned resource release or already-issued readiness input failed. Inspect the associated lifecycle error. |

## Developing the Codex enhancement

Install the locked development dependencies, then build and check the package:

```sh
npm ci                                      # Install exact registry dependencies
npm run build                               # Compile JavaScript and declarations
npm run typecheck                           # Check types during development
node --test tests/integration/native.test.ts # Run one focused protocol test file
npm run check                               # Formatting, lint, and types
npm test                                    # Full suite, including package checks
```

Development uses exact npm `issue-runner-core@0.1.1` through type-only imports. It needs no local Core archive or sibling checkout. Package tests install the built runtime without Core before checking declarations against development Core. Integration tests use injected capabilities and native protocol substitutes; they do not establish real terminal or model acceptance.

Read the [Core public integration contract](https://github.com/BuddyLabsCo/issue-runner-core/blob/main/docs/terminal-contract.md) for interfaces, [Codex protocol](https://github.com/BuddyLabsCo/issue-runner-agent-codex/blob/main/docs/codex-protocol.md) for native interactions, and [code architecture](https://github.com/BuddyLabsCo/issue-runner-agent-codex/blob/main/docs/code-architecture.md) for ownership and test placement. These repository links also work from the npm README. Publication after documentation cleanup remains the maintainer's decision.
