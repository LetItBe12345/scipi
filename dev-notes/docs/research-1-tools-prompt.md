# 需求 1 调研 — 工具与提示精简

> 对应 `PLAN.md` 需求 1：工具太多、提示太杂，要大删。目标：上下文更简洁。

## 工具层现状

- **32 个内置工具**，定义在 `scipi/packages/scipi-agent/src/tools/builtin-names.ts`（31 常量 + `image_gen`/`tts`/`resolve`）。
- **开关机制已存在，无需新写代码**：
  - 每个工具 `<tool>.enabled` 默认值，散在 `scipi/packages/scipi-agent/src/config/settings-schema.ts`。
  - `tools.discoveryMode`：`auto`/`all`/`mcp-only`/`off`，`auto` 阈值 40 才隐藏（见 `src/tool-discovery/mode.ts`）。builtin 才 32，默认不会自动隐藏。
  - 另有 `--tools`、`ttsr.disabledRules`。
- **默认开启约 22 个**：`read bash edit write eval search find lsp ast_grep ast_edit debug task job todo ask irc web_search ssh systemd memory_edit learn manage_skill`。
- **默认关闭**：`tts inspect_image checkpoint rewind github search_tool_bm25 retain recall reflect`。
- 工具说明 prompt：`scipi/packages/scipi-agent/src/prompts/tools/*.md`，共 **42 个文件**。

## system prompt 现状

- 主模板 `src/prompts/system/system-prompt.md`，**256 行**，常驻，结构杂：
  - `system-conventions` / `ROLE` / `Engineering Principles`
  - `Skills & Rules` / **Internal URLs（10+ 协议常驻：skill/rule/memory/agent/artifact/history/local/vault/mcp/issue/pr/omp）**
  - `Tool Inventory` / **`TOOL POLICY`（6 子节，大量 `{{#has tools "x"}}` 条件分支）**
  - **`EXECUTION WORKFLOW`（6 阶段）** / **`DELIVERY CONTRACT`（4 块）**
  - `personality` / `critical`
- 附属片段 `src/prompts/system/*.md`，**~50 个、共 1147 行**，多数按需注入：plan-mode、snapcompact、autolearn、memory、eager-task、irc、ttsr、orchestrate、title 等。
- personality 三套：`default` / `friendly` / `pragmatic`。
- 构建入口：`src/system-prompt.ts` `buildSystemPrompt()`；SDK fallback 默认工具 `DEFAULT_SYSTEM_PROMPT_TOOL_NAMES = ["read","bash","eval","edit","write"]`。

## 杂的根因

1. **工具多 → prompt 条件分支多**：`TOOL POLICY` 每条 `{{#has}}` 都渲染一段，工具越多 prompt 越长。
2. **Internal URLs 10+ 协议常驻**，与多数任务无关。
3. **WORKFLOW 6 阶段 + CONTRACT 4 块**全是常驻长文。
4. 附属片段虽按需，但 autolearn / memory / eager-task / orchestrate 等默认即注入。

## 精简方向（仅方向，未动手）

- **工具**：默认开启从 ~22 砍到核心 ~10（`read write edit bash search find lsp task ask todo`），其余改默认关闭、靠 `discoveryMode` 按需拉。
- **主 prompt**：砍 Internal URLs（只留常用）、删 `TOOL POLICY` 冗余分支、浓缩 `WORKFLOW`/`CONTRACT`。
- **附属片段**：关掉非必要默认注入（autolearn / memory-consolidation / eager-task / orchestrate / snapcompact-note 等）。
- **复用现有机制**：`<tool>.enabled` + `tools.discoveryMode` + 删/缩 `.md`，基本不用新写逻辑。

## 待定

- 核心工具集最终保留哪几个，需结合需求 2（先读项目再动手）一并定。
- 附属片段哪些算"非必要"，需逐个确认默认注入条件。
