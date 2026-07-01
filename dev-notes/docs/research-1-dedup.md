# 需求 1 · 层 1 去重分析

> 对应 `PLAN.md` 需求 1 / 层 1。范围：**只做去重**——删工具 `description` 与 system prompt `TOOL POLICY` 之间重复的选型规则。**不动示例、不动功能手册**（`edit` 的 `<example>`/`<anti-patterns>`、`eval` 的字段定义等一律保留）。

## 方法

- **选型规则**（"用 X 不用 Y"）统一留 `TOOL POLICY` 一处；工具 `desc` 里重复的选型规则删掉。
- 工具 `desc` **内部重复**（同一句在开头和 `<critical>` 各写一遍）删一份。
- 工具 `desc` 只保留"这工具怎么用"（功能 + 参数 + 用法），不再承担选型职责。

## 扫描结果

对 9 个核心常驻工具的 `desc` 扫描选型规则关键词（`not grep/rg/awk/ls`、`→ search/find/read/eval`、`not a browser`、`shell out to search` 等）：

| 工具 | desc 字符 | 选型句数 | 结论 |
|---|---|---|---|
| `bash` | 3152 | 3 + 1 处内部重复 | **有真双份，可去重** |
| `read` | 3010 | 1 | POLICY 无对应，非双份，**不动** |
| `edit` | 6645 | 0 | 无去重点（示例保留） |
| `eval` | 5539 | 0 | 无去重点 |
| `task` | 5460 | 0 | 无去重点 |
| `write` / `find` / `web_search` / `search_tool_bm25` | — | 0 | 无去重点 |

**结论：纯去重的可动点集中在 `bash.md` 一处。**

## bash 逐条分析

源文件：`scipi/packages/scipi-agent/src/prompts/tools/bash.md`

### 重复 1 — 内部重复（开头 ↔ `<critical>` 第一条）

`bash.md` 第 5 行和第 31 行讲的是同一件事：

```5:5:scipi/packages/scipi-agent/src/prompts/tools/bash.md
Bash invokes **real binaries** with simple args. It is NOT a scripting surface.
```

```31:31:scipi/packages/scipi-agent/src/prompts/tools/bash.md
- Bash invokes real binaries with simple args; it is NOT a scripting surface. Loops, conditionals, heredocs, inline interpreter scripts (`-e`/`-c`/`--eval`) when an eval runtime exists, several piped stages, or quote/JSON escaping mean you're writing a program → use `eval` cells: restartable, stateful, and free of shell-quoting traps.
```

第 31 行 `<critical>` 第一条是第 5-15 行的浓缩复述。**建议删第 31 行整条**（~430 字符），开头第 5 行保留作为定位。

### 重复 2 — `grep/rg → search`（与 POLICY 双份）

`bash.md` 第 32 行：

```32:32:scipi/packages/scipi-agent/src/prompts/tools/bash.md
- NEVER shell out to search content or files: `grep/rg` → `search`.
```

`system-prompt.md` 第 110 行已有：

```110:110:scipi/packages/scipi-agent/src/prompts/system/system-prompt.md
{{#has tools "search"}}- Regex search → `{{toolRefs.search}}`, not `grep`, `rg`, or `awk`.{{/has}}
```

**建议删 `bash.md` 第 32 行**（~62 字符）。`search` 是核心常驻，POLICY 这条必渲染。

### 重复 3 — `ls → read`、`find → find tool`（与 POLICY 双份）

`bash.md` 第 33 行：

```33:33:scipi/packages/scipi-agent/src/prompts/tools/bash.md
- NEVER use `ls` or `find` to list or locate files — `ls` → `read` (a directory path lists entries), `find` → the `find` tool (globbing). This is non-negotiable, even for a single quick listing.
```

`system-prompt.md` 第 106 + 111 行已覆盖：

```106:111:scipi/packages/scipi-agent/src/prompts/system/system-prompt.md
{{#has tools "read"}}- File or directory reads → `{{toolRefs.read}}` (a directory path lists entries).{{/has}}
{{#has tools "edit"}}- Surgical edits → `{{toolRefs.edit}}`.{{/has}}
{{#has tools "write"}}- Create or overwrite → `{{toolRefs.write}}`.{{/has}}
{{#has tools "lsp"}}- Code intelligence → `{{toolRefs.lsp}}`.{{/has}}
{{#has tools "search"}}- Regex search → `{{toolRefs.search}}`, not `grep`, `rg`, or `awk`.{{/has}}
{{#has tools "find"}}- Globbing → `{{toolRefs.find}}`, not `ls **/*.ext` or `fd`.{{/has}}
```

**建议删 `bash.md` 第 33 行**（~170 字符）。

### 重复 4 — "Anything below → eval" 列表（与 POLICY 双份）

`bash.md` 第 9-15 行列出 bash 的边界（heredocs/控制流/`$(…)`/多级管道 → eval）：

```9:15:scipi/packages/scipi-agent/src/prompts/tools/bash.md
Anything below → `eval` cell, not bash:
- Inline interpreter scripts (`-e`/`-c`/`--eval`) when an eval runtime exists for that language
- Heredocs (`<<EOF`), `while`/`for`/`if`/`case` shell control flow
- `$(…)` command substitution nested inside another command
- Pipelines with more than two stages, or stages that need control flow or quote/JSON escaping
- Multiline commands, `&&`-chains mixing control flow
- Quote/JSON escaping that fights the shell
```

`system-prompt.md` 第 112 行的 `eval` 条已把同样的边界讲全：

```112:112:scipi/packages/scipi-agent/src/prompts/system/system-prompt.md
{{#has tools "eval"}}- Default for any compute: `{{toolRefs.eval}}` cells. Bash is the EXCEPTION — only single binary calls or short fact-computing pipelines (`wc -l`, `sort | uniq -c`, `diff`, checksums). The moment a command grows a loop, conditional, heredoc, `-e`/`-c` script, `$(…)` nesting, or >2 pipe stages, it's a program → `{{toolRefs.eval}}`. NEVER write multiline or inline-script bash.{{/has}}
```

**建议删 `bash.md` 第 9-15 行**（~380 字符）。边界靠 POLICY 第 112 行。

> 保留 `bash.md` 第 5、7 行（开场定位 + 具体例子 `comm`/`git status`，POLICY 未含这两个例子）。

## read 分析

`read.md` 的 `<instruction>` 里有：

> - SHOULD use `read` (not a browser tool) for web content; browser only when `read` can't deliver.

`TOOL POLICY` 只有 `inspect_image vs read`（第 102 行），**没有 `read vs browser`**。所以这条**非双份**。

- 若要收口：删 `read.md` 这条 + 在 POLICY 加一条 `read vs browser` → 净收益约 0（一边删一边加）。
- **建议不动 `read`。**

## 风险

- POLICY 第 112 行（eval 边界）是 `{{#has tools "eval"}}` 条件渲染。`eval` 在 `DEFAULT_ESSENTIAL_TOOL_NAMES` 核心集里，默认常驻 → 这条总会渲染，安全。
- **唯一风险**：用户用 `tools.essentialOverride` 自定义核心集、把 `eval` 移出 → POLICY 112 不渲染，而 `bash.md` 第 9-15 行又删了 → bash 边界丢失。默认配置不触发；可在 `bash.md` 留一行兜底提示（"边界见 TOOL POLICY"）规避。

## 量化

| 项 | 原始 | 去重后 | 省 |
|---|---|---|---|
| `bash` desc | 3152 字符 | ~2110 字符 | ~1042 字符 ≈ 260 token |
| `read` desc | 3010 | 3010 | 0（不动） |
| 其余 7 个 | — | — | 0 |
| **合计** | | | **~1042 字符 ≈ 260 token** |

占当前 `tools` 字段（34122 字符）约 3%。**纯去重收益有限。**

## 结论

- 层 1 纯去重可做，但收益小（~260 token），集中在 `bash.md` 删 4 处。
- 真正的大头在：
  - **层 2**：`TOOL POLICY` 自身（2575 字符）、`DELIVERY CONTRACT`（4135）、`WORKFLOW`（2228）的浓缩 —— 预估省 ~1.2k token。
  - **层 1 压缩**（用户暂不做）：`bash.md` 的 `# Output minimizer`、`# Timeout and async` 措辞浓缩等。
- 去重与层 2 有联动：删 `bash.md` 选型规则后，POLICY 对应条目成为唯一来源，后续浓缩 POLICY 时需一并保留这些选型语义。

## 待确认

是否按本文删 `bash.md` 的 4 处（第 9-15、31、32、33 行）？若同意，我会：
1. 只改 `bash.md` 一个文件，小步提交。
2. 改完给出 diff，等确认再做层 2。
