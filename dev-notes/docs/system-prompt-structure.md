# Agent 系统提示词结构

> 范围：`scipi/packages/scipi-agent`。讲清楚系统提示词（上游请求体的 `instructions` 字段）在哪些文件、包含什么、怎么组装起来。不讲工具结构（见 `tool-structure.md`）、不讲动态历史。

## 1. 系统提示词在哪

- 文件目录：`scipi/packages/scipi-agent/src/prompts/system/`
- 进请求体：渲染后作为 `instructions` 字段发给上游 LLM provider（真实样本约 12907 字符）。

## 2. 组装总览：常驻 + 附属

系统提示词分两块：

- **常驻**：会话一开始就全程带着，由 `buildSystemPrompt()` 产出 = **主模板 + 项目尾**。
- **附属片段**：会话运行中按事件/状态注入（plan 模式、IRC 来消息、TTSR 中断、压缩等），非常驻。

## 3. 常驻：主模板 + 项目尾

### 主模板 `prompts/system/system-prompt.md`（258 行）

按顺序的节：

1. `<system-conventions>` — RFC 2119 关键词、XML 标签规则
2. `ROLE` — 助手定位 + `# Engineering Principles`
3. `RUNTIME` — `# Skills & Rules`（技能列表 + 通用规则 + 域规则）+ `# Internal URLs`（11 个内部链接）+ `# Tool Inventory`（工具名清单）+ `<discovery-notice>`（可发现 MCP 服务器）
4. `TOOL POLICY` — `# General` / `# Tool I/O` / `# Specialized Tools`（选型规则）/ `# Exploration` / `# LSP` / `# AST` / `# Delegation`
5. `EXECUTION WORKFLOW` — 6 阶段：Scope / Research Before Editing（需求 2 先读再改）/ Decompose / Implement / Verify / Cleanup
6. `DELIVERY CONTRACT` — 4 块：`<contract>` / `<completeness>` / `<evidence-and-output>` / `<yielding>`
7. `<personality>` — 三套选一
8. `<critical>` — 不叙述 token 预算、不重复审计已应用编辑

主模板是 mustache 模板，用 `{{#has tools "x"}}`、`{{#if}}` 等条件渲染。

### 项目尾 `prompts/system/project-prompt.md`

- `<workstation>` — OS / 内核 / CPU / GPU / 型号
- `<context>` — 自动注入的 contextFiles 全文（如 `CLAUDE.md`）
- `<dir-context>` — `AGENTS.md` 等只列路径、不注入全文
- `<workspace-tree>` — 工作目录树（`includeWorkspaceTree` 开了才有，默认 false）
- 日期 + cwd
- `<critical>` — 需求 2：先读再改、每轮推进、验证改动
- `{{appendPrompt}}` — 追加 prompt

### 自定义 prompt

`prompts/system/custom-system-prompt.md`：当用户提供 `customPrompt`/`resolvedCustomPrompt` 时改用这个模板（block 0 由 caller 拥有，不走 `SYSTEM.md` walk-up）。

## 4. 附属片段（~50 个，按事件注入）

文件都在 `prompts/system/*.md`，按事件/状态在 `session/agent-session.ts` 里注入。**两种注入方式**：

- **追加到 systemPrompt 数组**：如 advisor watchdog（`systemPrompt.push(...)`）
- **作 `role:"custom"` 隐藏消息插入对话流**：如 `orchestrate-notice`/`workflow-notice`（`customType` + `display:false` + `attribution:"user"`）

按类列举：

| 类 | 片段 | 触发 |
|---|---|---|
| Plan 模式 | `plan-mode-active` / `plan-mode-approved` / `plan-mode-compact-instructions` / `plan-mode-reference` / `plan-mode-subagent` / `plan-mode-tool-decision-reminder` | 进入 plan 模式 |
| IRC | `irc-incoming` / `irc-autoreply` | IRC 来消息 |
| TTSR | `ttsr-interrupt` / `ttsr-tool-reminder` | TTSR 中断 |
| 压缩 | `snapcompact-context-frames-note` / `snapcompact-context-stub` / `snapcompact-system-frames-note` / `snapcompact-system-stub` / `snapcompact-toolresult-note` | context 压缩 |
| 自学 | `autolearn-guidance` / `autolearn-guidance-learn` / `autolearn-nudge` / `autolearn-nudge-autocontinue` | `autolearn.enabled`（默认 false） |
| 记忆 | `memory-consolidation-system` / `memory-extraction-system` | `memories.enabled`（默认 false） |
| 标题 | `tiny-title-system` / `title-system` / `title-system-marker` / `title-marker-instruction` | 生成会话标题 |
| 编排/工作流 | `orchestrate-notice` / `workflow-notice` / `background-tan-dispatch` / `eager-task` / `eager-todo` | 编排/急切任务 |
| 子代理 | `subagent-system-prompt` / `subagent-user-prompt` / `subagent-yield-reminder` | task 子代理 |
| 停止/继续 | `auto-continue` / `manual-continue` / `empty-stop-retry` / `unexpected-stop-retry` / `unexpected-stop-classifier` | 异常停止 |
| 其它 | `commit-message-system` / `web-search` / `btw-user` / `omfg-user` / `ultrathink-notice` / `side-channel-no-tools` / `auto-thinking-difficulty` / `agent-creation-architect` / `agent-creation-user` | 各场景 |

## 5. 组装流程：`buildSystemPrompt()`

入口：`src/system-prompt.ts:435`。步骤：

1. **并行加载**（`Promise.all` + 超时兜底 `withDeadline`，超时 `SYSTEM_PROMPT_PREP_TIMEOUT_MS`）：
   - `resolvedCustomPrompt` / `resolvedAppendPrompt` — 用户/CLI 传入
   - `systemPromptCustomization` — `loadSystemPromptFiles`（`SYSTEM.md` walk-up）
   - `contextFiles` — `loadProjectContextFiles`
   - `skills` — `loadSkills`
   - `workspaceTree` — `buildWorkspaceTree`（`includeWorkspaceTree` 开才建）
2. **工具元数据**：从 `tools` map 算 `toolNames` / `toolInfo` / `toolRefs` / `toolInventory`。`toolListMode = !inlineToolDescriptors && nativeTools`（默认 true → compact 工具名列表）。
3. **过滤技能**：`filteredSkills` = 需要 `read` 工具 + 非隐藏（`hide:true`）。
4. **去重规则**：`dedupePromptSource` / `dedupeAlwaysApplyRules`（避免 contextFiles/customPrompt/appendPrompt 间重复）。
5. **组装渲染数据 `data`**：tools / toolInfo / toolInventory / skills / rules / alwaysApplyRules / environment / contextFiles / agentsMdSearch / workspaceTree / personality / intentTracing / mcpDiscoveryMode / eagerTasks / secretsEnabled / hasMemoryRoot / hasObsidian / includeWorkspaceTree / date / cwd / model。
6. **渲染**：`prompt.render(systemPromptTemplate, data)` → `rendered`；再 `prompt.render(projectPromptTemplate, data)` → `projectPrompt`。
7. **返回** `{ systemPrompt: [rendered, projectPrompt] }`。

## 6. 渲染数据从哪来

| 数据 | 来源 |
|---|---|
| skills | `loadSkills`（`extensibility/skills`） |
| rules / alwaysApplyRules | **多源 discovery**：`discovery/omp-plugins.ts` / `cursor.ts` / `windsurf.ts` / `cline.ts` / `gemini.ts` / `codex.ts` / `opencode.ts` 各有 `loadRules`，兼容各种 agent 框架的规则文件 |
| contextFiles | `loadProjectContextFiles`（`CLAUDE.md` 等自动 context） |
| agentsMdFiles | `workspaceTree.agentsMdFiles`（`AGENTS.md` 等，只列路径不注入全文） |
| workspaceTree | `buildWorkspaceTree`（`includeWorkspaceTree` 默认 false，不注入） |
| personality | `prompts/system/personalities/*.md`（`default` / `friendly` / `pragmatic`，三套选一） |
| 工具元数据 | `tools` map（见 `tool-structure.md`） |
| environment | `getEnvironmentInfo` |
| 开关 | `config/settings-schema.ts`：`inlineToolDescriptors`(false) / `nativeTools`(true) / `tools.intentTracing`(true) / `task.eager` / `tools.discoveryMode` / `secrets.enabled`(false) / `memory.backend` / `includeWorkspaceTree`(false) / `includeModelInPrompt` |

## 7. 涉及文件

```
scipi/packages/scipi-agent/src/
├── system-prompt.ts            # buildSystemPrompt() 组装入口
├── prompts/
│   └── system/
│       ├── system-prompt.md         # 主模板（258 行）
│       ├── project-prompt.md        # 项目尾
│       ├── custom-system-prompt.md  # 自定义 prompt 模板
│       ├── personalities/           # default / friendly / pragmatic
│       ├── plan-mode-*.md           # plan 模式片段
│       ├── irc-*.md / ttsr-*.md     # IRC / TTSR 片段
│       ├── snapcompact-*.md         # 压缩片段
│       ├── autolearn-*.md / memory-*.md  # 自学 / 记忆片段
│       ├── title-*.md               # 标题片段
│       ├── orchestrate-notice.md / workflow-notice.md / background-tan-dispatch.md / eager-*.md
│       ├── subagent-*.md            # 子代理片段
│       └── ...其它附属片段
├── session/
│   └── agent-session.ts        # 附属片段按事件注入（import 片段 + push / 插入 custom 消息）
├── discovery/
│   └── *.ts                    # 多源 rules/contextFiles 加载（OMP/Cursor/Windsurf/Cline/Gemini/Codex/OpenCode）
└── config/
    └── settings-schema.ts      # 各开关默认值
```

## 8. 精简参考

- 层 2 模板精简（砍 Internal URLs + 浓缩 CONTRACT/WORKFLOW/POLICY）：详见 `docs/research-1-prompt-trim.md`，预估省 ~510 token。
