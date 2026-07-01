---
name: llm-feature-e2e-testing
description: Test a newly integrated tool or feature through the real LLM/provider path in this repo. Use when a change must be verified end-to-end as `CLI -> provider -> model tool selection -> real tool execution -> observable side effect`, not just with mocked runners or unit tests. Covers preflight checks, forcing a real tool call, capturing provider evidence, diagnosing environment-vs-provider failures, and cleaning up real external side effects such as `systemd --user` services.
---

# LLM Feature End-to-End Testing

This skill is for **real integration testing of newly added agent features** in this repo.

The goal is not “does the tool class work in isolation?” The goal is:

1. the CLI/session exposes the feature,
2. the provider request contains the tool/schema/prompt you expect,
3. the model actually chooses or can be forced to choose the tool,
4. the tool executes against the real host environment,
5. the side effect is externally verified,
6. cleanup happens.

If you only tested with fake runners, mocked `runCommand`, or unit assertions on a tool result object, you have **not** finished end-to-end testing.

## Use this when

Use this skill when any of these are true:

- a new built-in tool was added
- a tool was connected to a new provider/model
- a tool depends on host capabilities (`systemd`, browser, SSH, local binaries, DBus, filesystems, credentials, etc.)
- the user explicitly asks for “真实测试 / 端到端 / real provider / real tool call”
- you need proof that the LLM can really invoke the feature through the shipping CLI

## Repo-default model policy for this workflow

When the user asks for real LLM/provider end-to-end testing of a new feature in this repo and does not later override the model explicitly, default to:

- **model:** `gpt-5.4`
- **reasoning:** `high`

Do not silently substitute a cheaper, faster, or merely convenient model because a different credential is already available. If `gpt-5.4` is unavailable on the requested provider/account path, treat that as a real test precondition failure and report it explicitly.

If the user names both a target model family and a provider/account route, verify that exact route first before considering any fallback.

## Acceptance bar

For a new feature to count as truly tested, you should produce evidence for **all** applicable layers:

- **Registration:** the tool/feature is discoverable or enabled as intended
- **Provider payload:** the provider request actually includes the tool/schema/prompt
- **Model behavior:** the model actually emits the tool call, or follows a forcing prompt that causes it to do so
- **Execution:** the real tool runs against the real environment
- **External verification:** the effect is verified outside the tool result itself
- **Cleanup:** any created external resource is stopped/removed/reset

## Workflow

### 1) Preflight: verify the environment before blaming the model

Check the host prerequisites directly with shell first.

Examples:

```bash
systemctl --user show --property=Version --value
which systemd-run
which journalctl
```

For provider-backed tests, verify credentials **through the repo's own auth path**, not by guessing environment variables.

Examples in this repo:

```bash
bun run packages/scipi-agent/src/cli.ts token anthropic
bun run packages/scipi-agent/src/cli.ts token openai-codex
bun run packages/scipi-agent/src/cli.ts models ls
```

If provider auth is unavailable, do **not** pretend the LLM path was tested. Say exactly which provider/model path is missing.

### 2) Enable the feature in the same way users would

Prefer project config overlays over ad-hoc code edits when testing availability gates.

Example: create a minimal overlay for a gated tool.

```yaml
systemd:
  enabled: true
```

Then pass it through the CLI with `--config <file>` or the repo's equivalent runtime config path.

### 3) Force exactly one real tool call

When testing a tool, do **not** rely on a vague prompt like “please use the tool if helpful”.

Use a strict appended system prompt that says:

- call this tool exactly once,
- with these arguments,
- use no other tools,
- after the tool result, answer in a narrow, easy-to-check format.

Example pattern:

```text
Call the <tool> tool exactly once with <arguments>. Do not use any other tool. After the tool result, respond with only <field>.
```

This reduces ambiguity between:

- model refusal,
- provider tool schema issues,
- selection heuristics,
- actual tool/runtime failures.

### 4) Run through the real CLI and real provider

Use the real command path that production users hit.

Example shape:

```bash
bun run packages/scipi-agent/src/cli.ts \
  -p \
  --config <overlay.yml> \
  --model <provider/model> \
  --tools <tool-name> \
  --append-system-prompt '<forcing instructions>' \
  '<user message>'
```

For this repo, if you need a high-reasoning Codex path, prefer a model/account combination that is actually supported by the stored credential. Verify that first.

### 4.5) You MUST exercise the post-tool model turn

For this workflow, a successful tool call alone is **not** enough.

You must verify the complete loop:

1. the model receives the tool,
2. the model emits the tool call,
3. the tool executes,
4. the tool result is returned to the model,
5. the model produces a final answer **based on that returned tool result**, and
6. you independently verify the claimed side effect locally.

If you only proved any subset such as:

- the provider payload contained the tool,
- the model emitted the tool call, or
- the tool created the side effect,

then you have **not** completed this end-to-end test.

Use a forcing prompt that requires a final answer derived from the tool result, not a blind confirmation. Example pattern:

```text
Call the <tool> exactly once with <args>. After the tool result comes back, answer with only <field derived from the tool result>.
```

Then verify both:

- the returned final answer content, and
- the external system state that answer refers to.

### 5) Capture provider-side evidence

When the LLM path fails, inspect the provider request log instead of guessing.

In this repo, useful evidence may include logs under:

- `~/.scipi/logs/http-400-requests/`

What to confirm there:

- the intended provider was used
- the expected model was used
- the `tools` array contains the tool you added
- the tool description/parameters look sane
- the failure happened before or after model-side tool selection

This lets you distinguish:

- feature not exposed
- provider/model incompatibility
- auth/scope failure
- prompt/tool schema problem
- tool runtime failure

### 6) Verify the side effect outside the tool result

Never treat “the tool returned success” as sufficient proof.

Verify with the source of truth for the external system.

For `systemd --user`, verify with:

```bash
systemctl --user show <unit> --property=Id,Description,LoadState,ActiveState,SubState,Environment
journalctl --user --unit <unit> --no-pager --output=short-iso --lines 20
systemctl --user list-units --type=service --all --no-pager --plain --no-legend 'omp-*.service'
systemctl --user stop <unit>
```

General rule:

- browser feature → verify in browser / DOM / screenshot / network
- filesystem feature → verify files on disk
- process manager feature → verify through the process manager
- database feature → verify with a real readback query
- provider-side feature → verify in provider response/logs or system of record

### 7) Clean up

Real E2E tests create real garbage if you let them.

For any external effect, clean it up before yielding:

- stop spawned user services
- reset temporary config overlays if needed
- remove temporary files when they are only test scaffolding
- note anything intentionally left behind

## Failure taxonomy

Use this to reason clearly when the test fails.

### A. Provider/auth failure

Symptoms:

- 401 / auth error
- unsupported model for the current account type
- missing scopes / permission errors

Meaning:

- the tool path was **not** fully tested yet
- do not blame the tool until a valid provider/model path is used

## Non-negotiable local verification rule

For this repo's LLM feature E2E work, you MUST execute and verify the returned message's claim **locally** whenever the feature has a host-visible side effect.

Examples:

- if the final answer returns a `systemd` unit name, inspect that exact unit locally
- if the final answer claims a file was written, read that file locally
- if the final answer claims a process is running, verify the process manager state locally
- if the final answer claims logs exist, fetch the logs locally

The final assistant message is not proof by itself. The local system of record is the proof.

This rule exists specifically to prevent a fake “tool call happened, probably fine” standard.

### B. Tool exposure failure

Symptoms:

- provider request contains no such tool
- CLI help/config says tool should exist but request payload omits it

Meaning:

- registration, gating, or active-tool selection is broken

### C. Model-selection failure

Symptoms:

- tool is in provider payload
- model answers without calling it
- no runtime/tool error occurs

Meaning:

- strengthen the forcing prompt
- reduce available tools
- narrow expected final response format

### D. Runtime environment failure

Symptoms:

- tool call happens, but execution fails with host-level errors
- ex: missing `DBUS_SESSION_BUS_ADDRESS`, missing binary, no browser, missing SSH agent

Meaning:

- the LLM path is working
- the runtime environment propagation or host preconditions are broken

### E. External-system failure

Symptoms:

- tool returns success but source-of-truth verification contradicts it

Meaning:

- this is a real bug; the tool result is lying or checking the wrong thing

## Repo-specific example: `systemd --user`

## Repo example policy: `systemd --user`

For `systemd` feature tests in this repo:

- use the real CLI
- use a real provider path
- default to `gpt-5.4` with high reasoning unless the user explicitly overrides it
- force exactly one `systemd` tool call
- require a post-tool final answer (for example, the exact returned unit name)
- inspect that exact unit locally with `systemctl --user show`
- inspect logs locally with `journalctl --user`
- verify presence in `list-units`
- stop the unit and verify the stopped state locally

Anything less is not a completed end-to-end test for this tool.

This repo hit a real failure mode that is worth remembering:

- shell-level `systemctl --user` worked
- provider request really included the `systemd` tool
- model really called the tool
- tool still failed with:
  - `Failed to connect to bus: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined`

Root cause:

- the non-interactive child-process env builder did not inherit the DBus/XDG runtime vars needed by `systemd --user`

Fix shape:

- preserve a safe POSIX env allowlist for non-interactive tool subprocesses, including:
  - `PATH`
  - `HOME`
  - `USER`
  - `LOGNAME`
  - `LANG` / locale
  - `TMPDIR`
  - `XDG_RUNTIME_DIR`
  - `DBUS_SESSION_BUS_ADDRESS`
  - `SSH_AUTH_SOCK` when relevant

Lesson:

- when the shell works but the tool does not, compare the tool subprocess environment with the parent shell before changing prompts or schemas.

## What to write down in the final report

For a real E2E test, report these explicitly:

1. **CLI command used**
2. **provider/model used**
3. **whether the provider request really contained the tool**
4. **the exact tool-call outcome**
5. **the external verification result**
6. **cleanup performed**
7. **what was not tested**

## Anti-patterns

### Wrong: only running unit tests

“`bun test ...` passed” is not real LLM E2E proof.

### Wrong: only proving host behavior

Running `systemd-run --user ...` manually proves the OS path, not the LLM→tool path.

### Wrong: only proving provider payload

Seeing the tool in the request proves exposure, not execution.

### Wrong: using fake credentials and concluding the feature is broken

A provider auth failure is not a tool failure.

### Wrong: trusting the tool result without external verification

Always verify against the real system of record.

## Minimal checklist

- [ ] host prerequisite verified directly
- [ ] real provider/model credential verified
- [ ] feature enabled through real config path
- [ ] forcing prompt prepared
- [ ] real CLI invocation executed
- [ ] provider payload inspected when needed
- [ ] external side effect verified independently
- [ ] created resource cleaned up
- [ ] report distinguishes provider/tool/runtime/system failures
