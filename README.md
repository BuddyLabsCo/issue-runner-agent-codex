# issue-runner-agent-codex

Optional Codex enhancement for Issue Runner. It prepares checkout and hook trust, verifies startup readiness, observes the exact native conversation, and requests bounded recovery for failed turns or missing handoffs. The terminal plugin starts and resumes Codex; Core coordinates Assignments and accepts handoffs.

## Prerequisites

Install and [authenticate native Codex](https://developers.openai.com/codex/auth) in the environment that runs your terminal command. Follow the [Codex CLI installation instructions](https://developers.openai.com/codex/cli), and make `codex` and `git` available on `PATH`.

The native protocol baseline is Codex CLI/app-server **0.166.0**, including `codex app-server daemon start` and `codex app-server proxy`. The interactive session must use the same shared daemon as the enhancement. In Codex **0.167.0**, command-line configuration overrides select an embedded server unless you specify `--remote unix://`; use it on both start and resume. See [Core's Codex connection guidance](https://github.com/BuddyLabsCo/issue-runner-core#codex-enhancement-requires---remote-unix).

This package declares Node.js `>=22.18.0 <23` and npm `>=11 <12`. Follow [Core prerequisites](https://github.com/BuddyLabsCo/issue-runner-core#prerequisites) for the terminal command, Git/GitHub setup, Agent permissions, and handoff skill.

## Getting started

Install the enhancement in the **same global npm prefix as your terminal command**. For example, use the Node/npm environment that installed `issue-runner-herdr`:

```sh
npm prefix --global                         # Check the terminal command's prefix
npm install --global issue-runner-agent-codex # Install the optional enhancement
```

Core discovers `issue-runner-agent-codex` for roles whose Agent identifier is `codex`; no separate activation command is needed. Core supplies the workflow runtime through your terminal package. This enhancement has no Core runtime or peer dependency.

Use these Codex commands in the role's `start` and `resume` values:

```sh
# Start on the shared daemon without an interactive update prompt
codex --remote unix:// -c check_for_update_on_startup=false
# Resume the exact saved conversation; Runner replaces {sessionref}
codex resume "{sessionref}" --remote unix:// -c check_for_update_on_startup=false
```

Retain your chosen model, effort, and native permission settings as appropriate for your environment. Configuration-field guidance belongs in [Core's shipped template comments](https://github.com/BuddyLabsCo/issue-runner-core/blob/main/templates/config.yaml), including Agent roles and shared `terminalPlugins.enhancements` options. Use [Core getting started](https://github.com/BuddyLabsCo/issue-runner-core#getting-started) for initialization and Run commands.

## Runtime notices and troubleshooting

Core activates the enhancement automatically for `codex` roles. A missing or contract-incompatible enhancement uses base startup; incompatible versions produce a skip notice. Invalid packages and initialization failures are errors. If activation is missing, check the role's `codex` identifier and the installation prefix. If readiness fails, check authentication, the shared-daemon flags, and startup prompts before retrying through [Core's Operator Pause](https://github.com/BuddyLabsCo/issue-runner-core#operator-pause).

Before Codex starts, the enhancement trusts the primary Git checkout and current hook definitions, then verifies effective trust. Preparing primary checkout trust replaces even an explicit `untrusted` value. Separate distrust overrides for the task cwd or Worktree and disabled project layers still block startup. Disabled hooks stay disabled.

Bare repositories and separate-git-dir layouts are unsupported. Trust changes persist after cleanup; preflight does not guarantee hook execution or dismiss arbitrary later dialogs.

Startup submits a GUID shell marker and a minimal `READY` prompt through the terminal. A marker's command-not-found result is expected: its native `userShell` record identifies the conversation. Readiness requires observing the matching model turn start, not its answer. Observation and successful trust preparation are quiet.

Enhancement notices use inherited Runner stderr and include `[codex] sessionref=<ref>` (`unbound` before identification):

| Notice | Meaning and response |
| --- | --- |
| `recovery=error attempt=1/3` | A final failed turn qualifies for an automatic recovery request. Native retries and active conversations suppress requests. Core owns the continuation input. |
| `recovery=missing-handoff attempt=1/3` | A completed or interrupted turn is idle without its expected handoff. Recovery waits before every request and rechecks native state and file presence. |
| `ACTION REQUIRED!!!` | The latest final reply starts with literal `[action required]`, allowing leading whitespace. Missing-handoff recovery pauses; inspect the conversation and resolve the requested action. |
| `recovery=error excluded=<classification>` | A budget, usage, authentication, model, context, or policy error needs attention instead of automatic recovery. |
| `recovery=<category> exhausted=3/3` | That Assignment's recovery budget is exhausted. Observation continues; inspect the conversation before continuing manually. Error and missing-handoff budgets are separate. |
| `observation disconnected` / `observation reconnect failed` | Recovery pauses while observation is unavailable. The enhancement retries every ten seconds without restarting Codex or the shared daemon. |
| `recovery operation failed` | A native refresh, file check, or Core recovery callback failed. Inspect Runner's error and the conversation; this is not another failed business turn. |
| `initialization cleanup failed` / `readiness input failed` | An owned resource release or already-issued readiness input failed. Inspect the associated lifecycle error. |

Attempt counts above are examples. A fresh Assignment resets both recovery budgets, even at the same handoff path. File presence suppresses recovery; Core still validates the handoff. See [template comments](https://github.com/BuddyLabsCo/issue-runner-core/blob/main/templates/config.yaml) for supported configuration fields.

Use Core troubleshooting to [continue a stopped conversation](https://github.com/BuddyLabsCo/issue-runner-core#continue-a-stopped-conversation), [request an omitted handoff](https://github.com/BuddyLabsCo/issue-runner-core#request-an-omitted-handoff), or [resolve startup trust blockers](https://github.com/BuddyLabsCo/issue-runner-core#folder-or-hook-trust-blocks-startup).

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
