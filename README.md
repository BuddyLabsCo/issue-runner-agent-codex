# issue-runner-agent-codex

Optional, terminal-independent observation and readiness for an exact Codex conversation, through Core's Enhancement contract v1. The terminal plugin starts or resumes interactive Codex. This package connects to the shared daemon and proves readiness through native userShell records.

## Install a development candidate

Use Node.js 22.18.0 and npm 11. Install native Codex separately and make `codex` available on the supplied environment's executable search path. This candidate targets Codex CLI/app-server **0.166.0**. Its version, CLI help, generated protocol, and shared-daemon initialization were checked locally. Full native conversation readiness, other native versions, and Windows execution have not been checked; the lifecycle tests use scripted native responses.

Build and pack from this checkout:

```sh
npm ci
npm run check
npm test
npm pack --json
```

Install the resulting `issue-runner-agent-codex-0.0.0-dev.1.tgz` into your consumer. The tarball contains JavaScript and declarations and requires no terminal-plugin dependency. Core is a type-only, optional peer pinned to the verified `0.0.0-contract.1` contract artifact.

The development dependency is the supplied `issue-runner-core-contract.1.tgz`, with SHA-256 `89faaac1a8b49c12210834cd641def37fc724833862ef35b48e922470ebb5f96`. `package-lock.json` records its local source, version, and SHA-512 integrity. This artifact verifies the contract; it does not establish full Core/Herdr product integration or registry availability.

## Host the lifecycle

Pass a Tab-bound Host implementing `read`, `submitText`, ordered `sendKeys`, and argument-free `requestRecovery`, as defined by `issue-runner-core/terminal`. Pass only `cwd` and an environment overlay in context. Await the factory before starting the Agent:

```typescript
import { createEnhancement } from "issue-runner-agent-codex";

const enhancement = await createEnhancement(host, { cwd, env }, options);
try {
  await enhancement.startMonitoring(sessionref);
  await startOrResumeThroughTerminal();
  const ref = await enhancement.waitUntilReady();
  enhancement.onAssignment(expectedFile);
  // Core owns assignment delivery and handoff acceptance.
} finally {
  await enhancement.stop();
}
```

Call `startMonitoring` before submitting the configured Agent command. Supply the exact native conversation ref. Native `thread/resume` attaches the observer to that conversation without configuration overrides or business input; `thread/read` loads current state and history. Native notifications maintain observation, filtered by that ref. The terminal still owns the interactive start/resume command.

Each readiness wait submits `!` followed by the instance's GUID through `host.submitText`, then repeats after two seconds when the previous round has finished. Host retains its configured submit key. A userShell command containing the GUID proves readiness, including failed, nonzero, concatenated, or multiline commands. Model output does not prove readiness.

Detection stops marker scheduling and waits for an issued input round to finish. Each wait has its own deadline. After timeout, retry `waitUntilReady()` on the same instance: it retains its GUID, ref, and observation, and does not replay the Agent command. Overlapping waits share input rounds and retain separate deadlines. An instance without a supplied ref cannot claim readiness in this slice.

`onAssignment` retains the exact path string. A different path replaces the assignment; the same string continues it. Assignments are not mapped to native turns. New bound turns, assignment replacement, disconnect, and stop invalidate stale asynchronous observations.

## Configure shared enhancement options

Pass the whole shared enhancements options object. Unknown keys are left to their owners; no Agent namespace is required. These options use seconds:

| Option | Default | Validation |
| --- | --- | --- |
| `readyTimeout` | `20` | Finite, positive number |
| `retryLimit` | `3` per category | Nonnegative integer |
| `retryDelay` | `[10, 20, 40]` | Nonempty list of finite, nonnegative numbers |
| `handoffRecoveryDelaySeconds` | `120` | Finite, nonnegative number |

The recovery options are validated and defaulted for later recovery slices. This candidate sends no business recovery input and has no total recovery window.

## Stop and diagnose observation

A disconnect marks observation unavailable, rejects an active readiness wait, and prints a redacted notice to inherited Runner stderr. Binding, readiness, and native retries remain quiet. This slice schedules no reconnection.

Await `stop()` to cancel readiness and release the owned proxy, connection, subscriptions, and timers. Repeated calls wait for the same cleanup. Stop preserves the terminal, Agent, shared daemon, native history, and persisted configuration. An already-issued Host submission remains owned by Host.

The factory rejects initialization failures after cleaning partial resources. Host input failures propagate through readiness. This slice assumes checkout and hook trust are already established; preflight, unknown-ref discovery, recovery, and reconnection are separate tickets.

## Implementation and verification

The native boundary invokes `codex app-server daemon start` and `codex app-server proxy` with the supplied cwd/environment. Codex discovers its endpoint. The proxy carries WebSocket upgrade and framed messages, handled by `ws`; it is not treated as JSONL RPC. No private server, endpoint override, remote mode, or Agent TUI is started.

Protocol references are the [0.166.0 proxy dispatch](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/cli/src/main.rs) and [native WebSocket transport](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-transport/src/transport/unix_socket.rs). The initial snapshot uses the supported full-history `thread/read` response; that native API is deprecated for paginated threads and may require migration in a later native-version update.

Tests exercise the public factory through a bound Host, controlled time, and a scripted native byte bridge. The package test builds and installs the tarball with the supplied Core contract, compiles a consumer, and checks runtime exports. Installation prefers cached dependencies and fetches missing registry data when needed. CI already targets Ubuntu and Windows; implementation and fixtures use portable Node APIs.

See [code architecture](docs/code-architecture.md) and [ticket #2](https://github.com/BuddyLabsCo/issue-runner-agent-codex/issues/2) for ownership and scope.
