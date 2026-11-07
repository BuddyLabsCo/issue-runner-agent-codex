# Codex protocol

## Native interface inventory

The enhancement owns native communication through `src/codex/`; the terminal owns interactive Codex commands. This inventory describes the **0.166.0** protocol baseline actually used by the implementation. See [Core's public contract](https://github.com/BuddyLabsCo/issue-runner-core/blob/main/docs/terminal-contract.md) for injected capabilities.

| Native command | Purpose |
| --- | --- |
| `codex app-server daemon start` | Ensure the shared daemon exists using the supplied cwd/environment. |
| `codex app-server proxy` | Open an owned proxy to that daemon. The proxy carries WebSocket upgrade and framed JSON messages, not JSONL RPC; native Codex discovers the endpoint. |

| Request | Purpose and fields used |
| --- | --- |
| `initialize` | Identify the enhancement with `clientInfo`; disable `experimentalApi` and `requestAttestation`. |
| `config/read` | Read effective configuration for `cwd` with `includeLayers: true`; verify project trust and enabled project layers. |
| `config/value/write` | Upsert structured `projects` or `hooks.state` values through `keyPath`, `value` and `mergeStrategy: "upsert"`. Native Codex serializes path keys. |
| `hooks/list` | List current definitions for `cwds: [cwd]`, including hashes, trust, enabled state and inventory errors. |
| `thread/loaded/list` | Enumerate loaded conversation IDs through `cursor`/`nextCursor` while discovering the GUID marker. |
| `thread/resume` | Attach this observer to the exact `threadId` with `excludeTurns: true`, without settings overrides or business input. |
| `thread/read` | Read the exact `threadId` with `includeTurns: true` for discovery, initial state and recovery/reconnect refreshes. |

The client sends the `initialized` notification after successful initialization. Incoming event notifications supply these facts:

| Event notification | Purpose |
| --- | --- |
| `thread/started` | Trigger another discovery scan before binding. |
| `thread/status/changed` | Update the bound thread's active, idle or system-error status. |
| `turn/started` | Track the latest turn and correlate the readiness prompt with its turn ID. |
| `turn/completed` | Observe final turn state or trigger discovery before binding. |
| `item/started`, `item/completed` | Observe `commandExecution` items with `source: "userShell"`, bootstrap `userMessage` evidence and complete `agentMessage` replies. |
| `error` | Retain `willRetry` for the bound latest turn; suppress business recovery while native retry is active. |

Requests use numeric IDs and bounded waits. After binding, notifications must match the exact `threadId`; error evidence must also match the latest turn. The enhancement sends no native business-turn, interrupt, unsubscribe or daemon-stop requests. Full-history `thread/read` is deprecated for paginated threads; native-version changes may require migration. Protocol shapes were checked against the generated 0.166.0 schema; [native readiness evidence](https://github.com/BuddyLabsCo/issue-runner-agent-codex/issues/29) records the model-start persistence probe.

## Interaction sequences

### Connection and initialization

The owned proxy connects to the existing shared daemon; the enhancement does not start an interactive Agent or private server.

```mermaid
sequenceDiagram
    participant E as agent-codex
    participant N as Native Codex
    E->>N: codex app-server daemon start (cwd, env)
    N-->>E: Starter exits successfully
    E->>N: codex app-server proxy (cwd, env)
    E->>N: WebSocket upgrade through proxy bytes
    N-->>E: Connection opens
    E->>N: initialize (clientInfo, capabilities)
    N-->>E: Initialization result
    E->>N: initialized
```

### Checkout and hook trust

Portable Git discovery identifies the ordinary primary checkout, including from a linked Worktree. Preflight reads effective trust rather than matching warning text. Explicit task distrust or a disabled project layer rejects startup; warnings alone do not.

```mermaid
sequenceDiagram
    participant E as agent-codex
    participant N as Native Codex
    Note over E: Discover primary checkout<br/>and task root with Git
    E->>N: config/read (cwd, includeLayers)
    N-->>E: Effective configuration and layers
    opt Primary checkout is not trusted
        E->>N: config/value/write (projects, primary trust, upsert)
        N-->>E: Write result
        E->>N: config/read (cwd, includeLayers)
        N-->>E: Effective trust readback
    end
    Note over E: Verify effective checkout trust<br/>and task project layers
    E->>N: hooks/list (cwds)
    N-->>E: Current definitions, hashes and trust
    opt Untrusted or modified definitions exist
        E->>N: config/value/write (hooks.state, trusted_hash, upsert)
        N-->>E: Write result
    end
    E->>N: hooks/list (cwds)
    N-->>E: Current definitions must be trusted or managed
```

Hook writes preserve enabled flags and unrelated state. Persisted trust survives later failure or cleanup. Failed preflight releases only the enhancement's connection and proxy.

### Conversation identification and readiness

Readiness submits markers and the bootstrap prompt only through injected terminal I/O. A failed GUID shell command still proves identity through its native record. A supplied ref restricts discovery to that exact conversation.

```mermaid
sequenceDiagram
    participant E as agent-codex
    participant N as Native Codex
    opt Saved ref supplied to startMonitoring
        E->>N: thread/resume (exact threadId, excludeTurns)
        E->>N: thread/read (exact threadId, includeTurns)
        N-->>E: Current thread and history
    end
    loop Until this instance's GUID is observed
        Note over E: Submit !GUID<br/>through bound TerminalIO
        N-->>E: item/started or item/completed (userShell)
        opt No bound ref yet
            E->>N: thread/loaded/list (cursor when paging)
            N-->>E: Loaded IDs and nextCursor
            E->>N: thread/read (candidate threadId, includeTurns)
            N-->>E: History containing GUID command, or read failure
        end
    end
    opt Newly identified ref
        E->>N: thread/resume (matching threadId, excludeTurns)
        E->>N: thread/read (matching threadId, includeTurns)
        N-->>E: Current thread and history
    end
    Note over E: Finish issued GUID input<br/>Submit unique READY prompt<br/>through TerminalIO
    N-->>E: turn/started (bound threadId, turn ID)
    N-->>E: Matching userMessage in turn or item notification
    Note over E: Correlate both pieces<br/>Return exact ref before answer
```

GUID rounds repeat after two seconds while previous input has settled. Candidate history RPC failures allow other candidates and later scans; malformed required data rejects readiness. Each wait has its own deadline. Retry retains the instance's GUID, discovered ref and observation without replaying the Agent command. Model-start evidence lets settings persist before Core saves the ref; it does not repair settings lost by an older GUID-only session.

### State observation and reconnection

Recovery decisions use the latest bound thread, originating Assignment and expected file. Core receives only recovery requests; the enhancement never sends continuation text through native RPC.

```mermaid
sequenceDiagram
    participant E as agent-codex
    participant N as Native Codex
    N-->>E: thread/status/changed, turn and item notifications
    N-->>E: error (willRetry, if supplied)
    Note over E: Evaluate final state,<br/>final reply and Assignment
    opt Recovery remains eligible after its delay
        E->>N: thread/read (bound threadId, includeTurns)
        N-->>E: Latest native state
        Note over E: Recheck Assignment and file<br/>Call injected recovery callback
    end
    N--xE: Observation connection lost
    Note over E: Invalidate facts and stale work<br/>Wait ten seconds
    loop Retry until reattached or stopped
        E->>N: Open owned proxy and initialize
        N-->>E: Initialization result or failure
        opt Connected
            E->>N: initialized
            opt Ref already bound
                E->>N: thread/resume (same threadId, excludeTurns)
                E->>N: thread/read (same threadId, includeTurns)
                N-->>E: Refreshed current state
                Note over E: Reread if notifications<br/>supersede reconnect snapshot
            end
        end
        Note over E: On failure remain unavailable<br/>Retry after ten seconds
    end
    Note over E: Mark observation current<br/>Reevaluate with existing budgets
```

Reconnect restores subscriptions and current facts without replaying events, restarting Codex, reconstructing historical retry evidence or spending recovery attempts. Before binding, it restores availability without selecting a conversation. New turns, Assignment replacement, disconnect and stop invalidate stale work; refreshed facts use the same recovery and human-action rules.

### Stop and cleanup

Stop disables activity immediately, waits for issued injected operations, and releases only owned resources. Native history, persisted settings, other sessions and the shared daemon survive.

```mermaid
sequenceDiagram
    participant E as agent-codex
    participant N as Native Codex
    Note over E: Cancel timers and listeners<br/>for readiness, recovery,<br/>observation and reconnect
    Note over E: Reject pending RPC waits<br/>Ignore late responses
    E--xN: Terminate owned WebSocket and proxy stream
    E->>N: Release owned proxy process
    N-->>E: Proxy close confirmation
    Note over E: Await issued TerminalIO<br/>and recovery callbacks
    Note over E: Share stop attempt<br/>Retry unfinished releases<br/>after cleanup failure
```
