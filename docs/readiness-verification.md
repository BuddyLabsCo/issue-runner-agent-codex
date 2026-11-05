# Native readiness verification

On November 5, 2026, the changed enhancement passed an isolated native persistence probe for [ticket #29](https://github.com/BuddyLabsCo/issue-runner-agent-codex/issues/29). The probe used Codex CLI/shared daemon 0.166.0, Node 24.20.0, and npm 11.19.0 on Linux. The repository targets Node 22.18.x; Windows and full Core/terminal-plugin acceptance were not exercised.

The isolated home kept `model = "gpt-6.1-sol"` and `model_reasoning_effort = "high"` throughout both phases. Native `model/list` advertised `gpt-6.1-sol` and `gpt-6.1-terra`, both supporting medium effort. The interactive command requested the different model and effort:

```text
codex --remote unix:// --model gpt-6.1-terra -c model_reasoning_effort=medium --dangerously-bypass-approvals-and-sandbox
```

The changed enhancement ran its real factory, trust preflight, GUID discovery, and readiness lifecycle. Its injected TerminalIO bridged each submission to the owned interactive terminal, acknowledging after terminal submission. The diagnostic bridge used a 120-second readiness deadline to allow manual input forwarding; the default 20-second deadline and retry/cancellation behavior are covered by the lifecycle tests.

Readiness returned exact ref `01a1abef-d87a-7b60-9d33-8f6de6881922`. Immediate native `thread/read` found bootstrap turn `01a1abf1-d36a-76e2-b953-b93fb17384a3` still `inProgress`, containing the submitted user message and no assistant reply. A separate diagnostic observer interrupted this turn through `turn/interrupt`; readback reported `interrupted`. This interruption belongs only to the probe.

Native `thread/resume` readback reported model `gpt-6.1-terra` and reasoning effort `medium`. After stopping the enhancement and observer and closing the interactive terminal, the probe recreated the terminal and enhancement with the exact saved ref:

```text
codex resume 01a1abef-d87a-7b60-9d33-8f6de6881922 --remote unix:// --model gpt-6.1-terra -c model_reasoning_effort=medium --dangerously-bypass-approvals-and-sandbox
```

Before another readiness prompt, native readback again reported the exact ref, model `gpt-6.1-terra`, and effort `medium`. Both settings survived this close/resume without a completed bootstrap answer. This verifies persistence for the tested model pair and effort; it does not establish a more specific native root cause or repair settings already lost by an older GUID-only session.
