# systemd

> Submit and manage persistent `systemd --user` services for long-running local jobs.

## Source
- Entry: `packages/scipi-agent/src/tools/systemd.ts`
- Model-facing prompt: `packages/scipi-agent/src/prompts/tools/systemd.md`
- Key collaborators:
  - `packages/scipi-agent/src/tools/index.ts` — built-in registration and settings gate
  - `packages/scipi-agent/src/tools/builtin-names.ts` — public built-in name list
  - `packages/scipi-agent/src/config/settings-schema.ts` — `systemd.enabled`

## Scope / Boundary
- Linux only.
- User scope only: every command is `systemd --user`, never system scope.
- First version manages only `omp-*.service` transient units that still expose `OMP_MANAGED_BY=oh-my-pi-systemd` via `systemctl --user show`.
- No local DB: `systemctl --user` and `journalctl --user` stay the source of truth.
- Not wired into `AsyncJobManager`; use `job` / async `bash` for session-scoped background work.

## Inputs

| Field | Type | Required | Ops | Description |
| --- | --- | --- | --- | --- |
| `op` | `"submit" \| "status" \| "logs" \| "stop" \| "list"` | Yes | all | Operation selector. |
| `unit` | `string` | submit: No; status/logs/stop: Yes | submit/status/logs/stop | Managed unit name or short alias. Short aliases are normalized to `omp-<alias>.service`. |
| `command` | `string` | Yes | submit | Shell command executed as `/bin/sh -lc <command>`. |
| `cwd` | `string` | No | submit | Working directory for the service. Relative paths resolve from the tool session cwd. |
| `env` | `Record<string, string>` | No | submit | Extra environment variables passed via `systemd-run --setenv`. |
| `memory` | `string` | No | submit | `MemoryMax=` value, e.g. `16G`. |
| `cpuQuota` | `string` | No | submit | `CPUQuota=` value, e.g. `200%`. |
| `gpu` | `string` | No | submit | Lightweight GPU visibility selector; sets `CUDA_VISIBLE_DEVICES` and `NVIDIA_VISIBLE_DEVICES`. |
| `description` | `string` | No | submit | systemd unit description. Defaults to `oh-my-pi: <command preview>`. |
| `remainAfterExit` | `boolean` | No | submit | Adds `--remain-after-exit`. |
| `lines` | `number` | No | logs | Recent journal lines to return. Default `100`, max `500`. |

## Outputs
The tool returns plain text plus structured `details`.

`details` shape:
- `op: "submit" | "status" | "logs" | "stop" | "list"`
- `unit?: string`
- `units?: SystemdUnitSnapshot[]`
- `command?: string`
- `cwd?: string`
- `lines?: number`

`SystemdUnitSnapshot` carries the parsed `systemctl show` / `list-units` state fields that were available, including:
- `unit`
- `description`
- `loadState`
- `activeState`
- `subState`
- `result`
- `execMainPid`
- `execMainCode`
- `execMainStatus`
- `memoryCurrent`
- `cpuUsageNSec`
- `fragmentPath`
- timestamps / invocation metadata when `status` or `stop` read them

## Approval model
- Read tier: `list`, `status`, `logs`
- Exec tier: `submit`, `stop`

## Flow
1. `createTools()` exposes the tool only when `systemd.enabled` is true.
2. Every call verifies:
   - platform is Linux
   - required binaries are present in `PATH`
   - the user systemd manager is reachable via `systemctl --user`
3. `submit`:
   - normalizes or generates a managed unit name
   - resolves `cwd`
   - validates env names
   - maps resource fields to `systemd-run --user` flags
   - injects `OMP_MANAGED_BY=oh-my-pi-systemd`
   - runs `/bin/sh -lc <command>` inside a transient service
   - tries to re-read unit state with `systemctl --user show`; if the refresh loses a short-lived unit, submission still succeeds with a warning
4. `status` reads a unit through `systemctl --user show --property=...`, requires the managed marker, and renders a compact snapshot.
5. `logs` first verifies the loaded unit is marked as managed, then reads recent journal lines with `journalctl --user --unit <unit>`.
6. `stop` verifies the managed marker, runs `systemctl --user stop <unit>`, then best-effort refreshes status; a refresh miss becomes a warning instead of a failed stop.
7. `list` uses `systemctl --user list-units --all --type=service 'omp-*.service'`, re-checks each candidate through `systemctl --user show`, and returns only marker-verified managed units.

## Side effects
- `submit` creates a transient user service.
- `stop` changes process state for that service.
- `logs`, `status`, and `list` are read-only.
- No repo files or local metadata DB are touched by the tool itself.

## Limits / Current gaps
- No system-wide units.
- No arbitrary `--property` passthrough.
- No scheduler-level GPU management; `gpu` is env-level visibility only.
- No persistent metadata index beyond what systemd/journald already keep.
- `list` only sees still-loaded managed units; once systemd fully unloads a transient unit, it no longer appears there, and marker-gated `status` / `logs` / `stop` can no longer re-verify ownership without extra metadata.

## Errors
- Non-Linux use throws a `ToolError`.
- Missing binaries (`systemctl`, `systemd-run`, `journalctl`) throw a `ToolError`.
- Unreachable `systemd --user` manager throws a `ToolError` with command stderr/stdout.
- Op-specific semantic mismatches throw a `ToolError`, e.g. missing `command`, missing `unit`, unrelated fields on `list`, or a unit that lacks the managed marker.
- Failed systemd commands surface stderr first, then stdout, then a generic exit-code message.
- `submit` / `stop` do not fail just because the post-action status refresh lost a short-lived unit; they return a warning instead.
