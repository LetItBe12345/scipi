Submits and manages persistent `systemd --user` services for long-running local jobs.

Use this when work must survive the current session, terminal, or TUI closing.
This is OS-level persistence, not session-scoped async execution.

# Operations

## `op: "submit"`
Create a managed transient `systemd --user` service.
- `command` is required.
- `unit` is optional; omitted → auto-generated managed unit name.
- `cwd`, `env`, `memory`, `cpuQuota`, `gpu`, `description`, and `remainAfterExit` apply only here.
- `gpu` is a lightweight environment-level selector (`CUDA_VISIBLE_DEVICES` / `NVIDIA_VISIBLE_DEVICES`), not a scheduler.

## `op: "status"`
Read one managed unit's current state.
- `unit` is required.
- The unit must still be loaded in `systemd --user` and carry this tool's managed marker.

## `op: "logs"`
Read recent journal lines for one managed unit.
- `unit` is required.
- `lines` is optional and capped.
- The tool first verifies the loaded unit is marked as managed before reading logs.

## `op: "stop"`
Stop one managed unit.
- `unit` is required.
- The tool verifies the unit is marked as managed before stopping it.

## `op: "list"`
List managed `omp-*.service` units created through this tool.
- Do not pass unrelated fields.
- Only still-loaded units that carry this tool's managed marker are returned.

# Boundaries
- First version only supports Linux `systemd --user`.
- First version only manages `omp-*.service` transient services that still expose `OMP_MANAGED_BY=oh-my-pi-systemd` through `systemctl --user show`.
- This tool does **not** use the session async `job` manager.
- Prefer `job` / async `bash` for session-local background work; prefer `systemd` for persistent long-running tasks.
