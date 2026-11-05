# issue-runner-agent-codex

Optional observation, readiness, and bounded recovery for an exact Codex conversation, through Core's Enhancement contract v2. The terminal plugin starts or resumes interactive Codex. This package connects to the shared daemon, identifies the conversation through native userShell records, and starts a bootstrap model turn before returning readiness.

## Install a development candidate

Use Node.js 22.18.0 and npm 11. Install Git and native Codex separately; make `git` and `codex` available on the supplied environment's executable search path. This candidate targets Codex CLI/app-server **0.166.0**. Its version, CLI help, generated protocol, and shared-daemon initialization were checked locally. A [native readiness probe](docs/readiness-verification.md) verified model and effort persistence after interrupted bootstrap, daemon restart, and resume without reapplying either setting. Full joint integration, other native versions, and Windows execution have not been checked; the lifecycle tests use scripted native responses.

Build and pack from this checkout:

```sh
npm ci --ignore-scripts
npm --allow-scripts= run check
npm --allow-scripts= test
npm --allow-scripts= pack --json
```

Install the resulting `issue-runner-agent-codex-0.0.0-dev.1.tgz` into your consumer. The tarball contains JavaScript and declarations and requires no terminal-plugin dependency. Core is a development dependency used through type-only imports. The published package has no Core runtime dependency or peer dependency.

The development dependency remains `file:issue-runner-core-contract.1.tgz`. This complete Core package was built from a clean, isolated checkout of remote main at [commit `1bd2c4406978b168e3726c996fe7fbdae9ced8b4`](https://github.com/BuddyLabsCo/issue-runner-core/commit/1bd2c4406978b168e3726c996fe7fbdae9ced8b4). The filename is a storage convention, not the enhancement contract version.

| Artifact field | Value |
| --- | --- |
| Package version | `0.0.0-contract.1` |
| Enhancement contract | `2` |
| SHA-256 | `e11ddcc6900158b3f4ab3f91acc461dbd2c7f99ceb295c50c46ddced9310a65a` |
| npm pack SHA-1 | `3ea5ff3a688b919776689b7af38526da7f29dc4d` |
| Build toolchain | Node.js `24.20.0`, npm `11.19.0`, TypeScript `5.9.3` |

Core's documented workflow used `npm ci --ignore-scripts`, typechecking, its test suite, and `npm pack --json --pack-destination artifacts`. Packing ran Core's `prepack` build without changing its source or archive metadata. `package-lock.json` records the replacement archive's version and SHA-512 integrity. Local installation used a fresh cache and refreshed the installed declarations. This verifies the development artifact, not native Core/terminal integration or registry availability.

## Host the lifecycle

Core injects four arguments in order: bound `TerminalIO`, `RequestRecovery`, `EnhancementContext`, and unknown configuration. `TerminalIO` supplies `read`, `submitText`, and ordered `sendKeys`; `requestRecovery(assignmentId)` is a separate callback. Context contains `cwd` and an environment overlay. Await the factory before starting the Agent:

```typescript
import { createEnhancement } from "issue-runner-agent-codex";

const enhancement = await createEnhancement(
  io, requestRecovery, { cwd, env }, options,
);
try {
  await enhancement.startMonitoring(sessionref);
  await startOrResumeThroughTerminal();
  const ref = await enhancement.waitUntilReady();
  enhancement.onAssignment({ id: assignmentId, expectedFile });
  // Core owns assignment delivery and handoff acceptance.
} finally {
  await enhancement.stop();
}
```

Call `startMonitoring` before submitting the configured Agent command. When resuming, supply the exact native conversation ref. The enhancement searches only that conversation and never falls back to global discovery. Native `thread/resume` attaches the observer without configuration overrides or business input; `thread/read` loads current state and history. Native notifications maintain observation, filtered by that ref. The terminal still owns the interactive start/resume command.

For a new conversation, omit the ref: `await enhancement.startMonitoring()`. During readiness, the enhancement enumerates loaded threads through `thread/loaded/list` and inspects their native userShell commands. Only a command containing this Tab's GUID identifies the conversation. The enhancement binds its enclosing threadId and reads current state through the same observation path. It never selects by cwd, thread order, recency, filesystem markers, or model output. Tabs sharing a cwd have distinct GUIDs. Readiness rounds and native notifications trigger discovery scans; enumeration stops after binding.

A candidate's `thread/read` RPC failure does not end discovery. The scan continues through the remaining candidates and pages; later readiness rounds or notifications retry discovery. This lets a new conversation execute its first GUID shell before its history becomes readable. No native error code or message determines whether discovery continues.

Each readiness wait submits `!` followed by the instance's GUID through `io.submitText`, then repeats after two seconds when the previous round has finished. The terminal adapter retains its configured submit key. A userShell command containing the GUID proves identity, including failed, nonzero, concatenated, or multiline commands. Model output does not prove identity.

Detection stops marker scheduling immediately. Readiness waits for the subscription, initial current-state read, and any issued GUID input round to finish. Binding failures reject readiness.

After GUID discovery or validation of a supplied ref, the enhancement submits a minimal prompt through `io.submitText`: `Reply exactly READY. Do not use tools, modify files, or perform other work.` Each attempt appends a unique readiness token. Observation is installed before submission; the exact user-message text and native turn ID correlate a new `turn/started` to this prompt and session. The user-message item can arrive separately from the start notification. GUID shell turns, stale attempts, and other sessions cannot satisfy this condition.

Readiness returns the exact ref as soon as that model start is identified, even during pending prompt submission. It does not wait for completion or inspect assistant replies. Later model failure or interruption does not undo readiness; without an Assignment, it does not request business recovery. The enhancement never interrupts the bootstrap turn. Starting this turn lets selected settings persist before Core saves the ref; it does not reconstruct settings already lost by an older GUID-only session.

Each wait has its own deadline covering GUID detection and model start. Timeout rejects without claiming readiness. If candidate history reads failed, the timeout message identifies that failure and retains the last redacted error as its cause. Retry `waitUntilReady()` on the same instance: it retains its GUID, any discovered ref, and observation, and does not replay the Agent command. A new wait after all prior waits finish clears the previous discovery error and retries an unobserved bootstrap with a new token after pending input settles. Overlapping waits share input rounds and bootstrap evidence, retaining separate deadlines. Once bootstrap start is observed, later waits on the same instance reuse it.

`onAssignment({ id, expectedFile })` stores the ID and exact path synchronously. A fresh ID replaces the Assignment, cancels pending work, and resets both recovery budgets even when the path is unchanged. Repeating the same ID and path preserves its context. Recovery candidates retain the originating Assignment across timers, native refreshes, file checks, and reconnection. Assignments are not mapped to native turns. New bound turns, Assignment replacement, disconnect, and stop invalidate stale asynchronous observations. Readiness markers and bootstrap prompts never create an Assignment.

## Establish checkout and hook trust before startup

Await `createEnhancement` before starting Codex through the terminal. The factory resolves the task Worktree's absolute Git common directory and verifies the ordinary primary checkout containing that `.git` directory. It trusts that primary checkout, including when the supplied cwd is inside a linked Worktree. Bare repositories and separate-git-dir layouts are unsupported; no Core checkout field is required.

The factory reads effective native configuration for the supplied cwd. A null or missing projects map means no project trust is configured. If the primary checkout is not already trusted, the factory writes a structured project entry through `config/value/write` with upsert, then reads effective configuration again. Native Codex serializes path keys, including spaces, quotes, dots and backslashes. Other project entries, project fields and unrelated settings are preserved. Repeated creation leaves existing effective trust unchanged.

The factory also checks trust overrides for the supplied cwd and its Git task checkout root, and rejects disabled native project layers. An explicitly untrusted Worktree or cwd remains unchanged and prevents startup, even when the primary checkout is trusted.

The factory retains complete configuration warnings. It retires only Codex 0.166.0's recognized disabled-project warning when every named folder has an enabled project layer in effective configuration. This applies to both newly trusted and already-trusted checkouts.

Other initialization warnings remain fatal, including after a corrective trust write. Unknown warning formats and warnings received during writing or readback also reject the factory, as do Git failures, native configuration errors and managed write overrides.

After checkout trust succeeds, the factory lists hooks for the task cwd through `hooks/list`. It automatically trusts new and modified definitions by upserting their current hashes into `hooks.state` through `config/value/write`. It writes only `trusted_hash`, preserving enabled settings and unrelated hook state. Disabled hooks stay disabled; already-trusted and managed hooks need no write.

The factory re-lists hooks before returning and verifies the same keys and hashes are trusted, including managed hooks trusted by policy. Different keys, hashes or enabled settings prevent startup. Malformed responses, native errors, warnings and policy overrides also prevent startup. No allowlist, manual approval policy or bypass flag is used.

Failure releases the factory's owned connection and proxy; it preserves the shared daemon and other observers. A completed trust write remains persisted even if later verification fails. Successful trust changes are quiet and require no temporary Agent. This guarantees verified startup trust, not hook execution or dismissal of arbitrary later dialogs. Recreate the enhancement to prepare trust for definitions changed after preflight.

## Configure shared enhancement options

Pass the whole shared enhancements options object. Unknown keys are left to their owners; no Agent namespace is required. These options use seconds:

| Option | Default | Validation |
| --- | --- | --- |
| `readyTimeout` | `20` | Finite, positive number |
| `retryLimit` | `3` per category | Nonnegative integer |
| `retryDelay` | `[10, 20, 40]` | Nonempty list of finite, nonnegative numbers |
| `handoffRecoveryDelaySeconds` | `120` | Finite, nonnegative number |

`retryLimit` bounds recovery requests independently for errors and missing handoffs; `0` disables both. Error recovery waits `retryDelay` seconds before each request, reusing the last entry for additional attempts. Missing-handoff recovery waits `handoffRecoveryDelaySeconds` before every request. Cancelled waits consume no attempt or delay entry. There is no total recovery window.

## Recover final turn errors

With a current assignment, the enhancement recovers a latest failed turn only when its bound conversation is inactive (`idle` or `systemError`). Active turns, active conversations, native retries, and unavailable observations receive no recovery input. Missing historical `willRetry` evidence does not establish inactivity.

The native machine classifications `sessionBudgetExceeded`, `usageLimitExceeded`, `unauthorized`, `modelNotFound`, `contextWindowExceeded`, `cyberPolicy`, and `misalignmentPolicyViolation` are reported without automatic recovery, even alongside HTTP 429. Every remaining final turn error, including unknown or unclassified errors, uses the bounded error budget. Observation, transport, and local readiness failures do not count as failed business turns.

Before requesting recovery, the enhancement waits its configured delay, refreshes native state, and checks the originating Assignment's expected file. A present file suppresses the request; Core still owns handoff validation. A new bound turn, assignment replacement, loss of eligibility, disconnect, or stop cancels the pending wait. Later eligible endings start a fresh wait.

A fresh Assignment ID resets the error budget and delay position, including when it reuses the same expected-file path. Continuing the same Assignment and repeated observation refreshes preserve them. A later completed or interrupted turn resets them whether or not its handoff exists, then evaluates missing-handoff recovery independently.

Each attempt calls only `requestRecovery(originatingId)` after rechecking the Assignment, native state, and expected file. Core owns recovery wording and queues accepted input through the terminal adapter. The enhancement never composes continuation text or submits a business turn through RPC. A fulfilled callback completes the request, including Core's stale no-op; it does not prove native input occurred. Rejected callbacks remain operational errors and do not trigger failure retries. Excluded errors and exhaustion appear on inherited Runner stderr; each request prints `[codex] sessionref=<ref> recovery=error attempt=<attempt>/<limit>`. Scheduling, cancellation, and native retry activity remain quiet.

Core owns command launch, readiness pause controls, capability revocation, queue-time rejection of stale Assignment input, handoff acceptance, and tab closure. Native state/file checks and terminal input are not atomic: a new native turn or file can still appear after the final check.

## Recover missing handoffs and respect human action

With a current assignment, a completed or interrupted latest turn qualifies only when the bound thread is idle and the expected file is absent. A turn ending alone does not prove inactivity. Failed turns use only the error category.

Every missing-handoff attempt waits 120 seconds by default, including the first attempt. Its independent budget defaults to three recovery requests. Completed or interrupted turns without the file preserve this budget. File appearance resets it and stops pending missing-file recovery; a fresh Assignment ID resets both budgets, even at the same path. Continuing the same ID and refreshed observations preserve attempts.

The shared recovery path refreshes native state and checks the expected file immediately before input. New bound turns, changed assignments, loss of eligibility, disconnect and stop cancel stale work without consuming attempts. Exhaustion is reported while observation continues. Each recovery request prints `[codex] sessionref=<ref> recovery=missing-handoff attempt=<attempt>/<limit>` to inherited Runner stderr.

The complete latest final assistant reply controls human-action suppression, including replies loaded from current snapshots. Literal `[action required]` after leading whitespace cancels pending missing-handoff recovery and consumes no attempt. Commentary, partial answers and markers elsewhere in the reply do not request this pause. A match prints exactly `[codex] sessionref=<ref> ACTION REQUIRED!!!`. Observation continues, and later turns use their own output.

File presence establishes only that the expected path exists. Core still validates handoff contents, task completion and Git acceptance. The enhancement does not create handoffs, replay tasks or assert an assignment-to-native-turn mapping. Refreshed snapshots after reconnection use the same recovery policy.

## Stop and diagnose observation

A disconnect marks observation unavailable, rejects an active readiness wait, and prints a redacted notice to inherited Runner stderr. The enhancement retries observation after ten seconds and every ten seconds after a failed attempt, without an attempt limit. These retries run independently of business recovery budgets, including when `retryLimit` is zero.

Reconnection opens an owned proxy connection to the existing shared daemon, initializes the native protocol, and restores the bound conversation's subscription. It refreshes the latest thread and turn state before marking observation current. Notifications remain filtered by the same ref. If notifications supersede an in-flight snapshot, it reads again before publishing current state. Before GUID discovery has bound a conversation, reconnection restores availability without selecting a conversation.

The same enhancement, GUID, assignment, and recovery policy instances survive an outage. Refreshed current facts let installed policies evaluate work that finished while disconnected. Reconnection does not replay missed events, reconstruct historical `willRetry` evidence, spend or reset business budgets, or submit recovery input. Existing policies still own their eligibility, delays, budget resets, and full-reply human-action checks.

Each failed attempt prints `[codex] sessionref=<ref> observation reconnect failed` to inherited Runner stderr. Diagnostics omit wait times, credentials, close reasons, and native payloads. Binding, readiness, and native retry activity remain quiet. Reconnection never restarts the Agent or shared daemon.

Calling `stop()` immediately disables readiness, observation, reconnect, and recovery, and cancels their timers, waits, and subscriptions. Late native responses cannot restart activity. Stop waits for already-issued readiness input and recovery requests to settle under their injected capability contracts, without submitting replacement input. You can stop a newly returned instance before starting monitoring or readiness.

Concurrent stop calls share one cleanup attempt and its outcome. A resource-release failure rejects that attempt; a later `stop()` retries only unfinished releases. Completed releases are recorded, and stop has no additional effect after full success. Cleanup releases only this instance’s native connection and proxy. It preserves the terminal, Agent, shared daemon, unrelated conversations, other enhancements, native history, and persisted configuration.

The factory attempts cleanup when initialization or preflight fails, including partially constructed connections. It preserves the original error if cleanup also fails and reports `initialization cleanup failed` separately to inherited Runner stderr.

Terminal input failures, loaded-thread enumeration failures, invalid history responses, and binding failures propagate through readiness. Candidate history RPC failures remain pending until discovery succeeds or readiness times out. Asynchronous recovery callback or final-read failures remain available unchanged through active lifecycle calls and emit a redacted `recovery operation failed` diagnostic. A readiness input failure while stopping emits `readiness input failed`. Operational failures do not make cleanup reject or consume additional recovery attempts; stop rejects only remaining cleanup failures.

## Implementation and verification

The native boundary invokes `codex app-server daemon start` and `codex app-server proxy` with the supplied cwd/environment. Codex discovers its endpoint. The proxy carries WebSocket upgrade and framed messages, handled by `ws`; it is not treated as JSONL RPC. No private server, endpoint override, remote mode, or Agent TUI is started.

Protocol references are the [0.166.0 proxy dispatch](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/cli/src/main.rs), [native WebSocket transport](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-transport/src/transport/unix_socket.rs), [native project-warning format](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/lib.rs), [native hook trust writes](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/tui/src/hooks_rpc.rs), and [App Server configuration APIs](https://learn.chatgpt.com/docs/app-server). Trust request and response shapes were checked against the locally generated 0.166.0 protocol schema. The initial snapshot uses the supported full-history `thread/read` response; that native API is deprecated for paginated threads and may require migration in a later native-version update.

Tests exercise the public factory through separate bound terminal I/O and recovery callbacks, controlled time, and a scripted native byte bridge. Trust tests verify factory ordering, structured writes, current hook hashes, managed and disabled definitions, policy and warning rejection, mismatched readback, repeated creation and partial cleanup. Git discovery also runs against temporary ordinary and linked checkouts. The package test first installs and imports the runtime without Core. It then installs the development Core artifact to compile a declaration consumer and verify contract versions, export names, and archive integrity. A runtime resolver guard prevents ancestor development dependencies from hiding an accidental Core import. Installation prefers cached dependencies and fetches missing registry data when needed. CI already targets Ubuntu and Windows; implementation and fixtures use portable Node APIs.

Discovery tests cover multiple loaded threads and pages, same-cwd Tabs, nonmatching evidence, delayed loading, failed multiline commands, pending terminal input, timeout/retry, notification races, invalid pages, and stop during discovery. Loaded-thread request and response shapes were checked against the locally generated Codex 0.166.0 protocol schema. Joint integration acceptance and registry publication remain outside this ticket.

Recovery tests cover classifications, inactive system errors, native retry suppression, recovery-request accounting, delay reuse and exhaustion, reset/preservation, final state/file rechecks, cancellation during reads, and recovery callback failure propagation. Their primary seam is the public lifecycle with controlled time and scripted native/file boundaries. Error and status shapes were checked against the locally generated Codex 0.166.0 schema. Tests also cover same-path Assignment replacement across timers, native reads, file checks, and reattachment, plus fulfilled stale callbacks. Real joint integration and publication remain outside this ticket.

Missing-handoff tests extend that seam with every-attempt delays, independent budgets, file and assignment resets, final-read changes, cancellations, complete final replies, literal marker matching and later-turn reevaluation. Final assistant message and phase shapes were checked against the locally generated Codex 0.166.0 protocol.

Reconnection tests use the baseline capability/native fixtures and controlled time, including with business recovery disabled. They cover fixed unlimited retries, initialization and reattachment failures, timeouts, restored subscriptions, same-ref filtering, GUID continuity, snapshot races, and stop during waits and native requests. Additional policy integration checks cover endings during outages, full-reply human-action handling, and preserved assignment budgets. Real joint integration acceptance and registry publication remain outside this ticket.

Cleanup tests cover shared stop attempts, transient release failures, partial success without duplicate release, deferred terminal input, recovery callbacks, and proxy exit, operational errors during stop, factory failure cleanup, and instance isolation. They use the public lifecycle and portable native substitutes.

See [code architecture](docs/code-architecture.md), [ticket #2](https://github.com/BuddyLabsCo/issue-runner-agent-codex/issues/2), [ticket #3](https://github.com/BuddyLabsCo/issue-runner-agent-codex/issues/3), [ticket #4](https://github.com/BuddyLabsCo/issue-runner-agent-codex/issues/4), [ticket #5](https://github.com/BuddyLabsCo/issue-runner-agent-codex/issues/5), [ticket #6](https://github.com/BuddyLabsCo/issue-runner-agent-codex/issues/6), and [ticket #7](https://github.com/BuddyLabsCo/issue-runner-agent-codex/issues/7) for ownership and scope.
