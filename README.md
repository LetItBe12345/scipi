# scipi

A slimmer, context-lighter, long-task-friendly coding agent.

Fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (omp), which is itself a fork of [badlogic/pi-mono](https://github.com/badlogic/pi-mono).

[中文](README.zh-CN.md)

## Goal

Make the agent's upstream payload smaller and longer-task safer:

- Fewer tools loaded by default; the rest discoverable on demand.
- A leaner system prompt.
- Read the project before editing it.

## What changed vs upstream

**Rename**

- `omp` → `scipi` (root config; package `coding-agent` → `scipi-agent`).

**Requirement 1 — trim tools & prompt**

- `tools.discoveryMode` defaults to `all`: 8 core tools stay loaded (`read bash edit write find eval task web_search`) plus `search_tool_bm25`; the rest hide behind BM25 search and surface on demand. The `tools` field shrinks ~57% in real sessions.
- Layer 1: deduplicated the `bash` tool description against `TOOL POLICY` (commit `8058d0dff`).
- Layer 2: trimmed `system-prompt.md` — dropped low-frequency internal URLs (`omp://`; tightened `vault` / `issue` / `pr` exposure) and condensed wording.

**Requirement 2 — read before edit**

- `system-prompt.md` `# 2. Research Before Editing` and `project-prompt.md` `<critical>`: the first `edit` / `write` / `ast_edit` is blocked until at least one project file has been read.

## Roadmap

- Layer 2 remainder: condense `EXECUTION WORKFLOW` / `DELIVERY CONTRACT` / `TOOL POLICY` further.
- Dynamic history: tune `shellMinimizer` / `compaction` / `snapcompact` thresholds.
- More token savings across the upstream payload.

## Dev notes

Workspace notes (planning, research, architecture) live in [`dev-notes/`](dev-notes/):

- [`dev-notes/PLAN.md`](dev-notes/PLAN.md) — requirements plan
- [`dev-notes/AGENTS.md`](dev-notes/AGENTS.md) — workspace rules
- [`dev-notes/docs/tool-structure.md`](dev-notes/docs/tool-structure.md) — tool structure
- [`dev-notes/docs/system-prompt-structure.md`](dev-notes/docs/system-prompt-structure.md) — system prompt structure
- [`dev-notes/docs/research-1-*.md`](dev-notes/docs) — trimming research

## License

Inherits the upstream license. See [LICENSE](LICENSE).
