# scipi

一个更精简、上下文更轻、对长任务更友好的编码 agent。

[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）的 fork，omp 本身 fork 自 [badlogic/pi-mono](https://github.com/badlogic/pi-mono)。

[English](README.md)

## 目标

让传给上游模型的载荷更小、长任务更稳：

- 默认少加载工具，其余按需发现。
- 更精简的系统提示词。
- 改代码前先读项目。

## 相对上游的改动

**重命名**

- `omp` → `scipi`（根配置；包 `coding-agent` → `scipi-agent`）。

**需求 1 — 精简工具与提示**

- `tools.discoveryMode` 默认 `all`：8 个核心工具常驻（`read bash edit write find eval task web_search`）外加 `search_tool_bm25`；其余藏到 BM25 搜索后按需拉取。真实会话里 `tools` 字段省约 57%。
- 层 1：`bash` 工具描述与 `TOOL POLICY` 去重（提交 `8058d0dff`）。
- 层 2：精简 `system-prompt.md`——砍低频内部链接（`omp://`；收紧 `vault` / `issue` / `pr` 暴露）并浓缩措辞。

**需求 2 — 先读再改**

- `system-prompt.md` `# 2. Research Before Editing` 与 `project-prompt.md` `<critical>`：在读取至少一个项目文件前，禁止首次 `edit` / `write` / `ast_edit`。

## 路线图

- 层 2 剩余：进一步浓缩 `EXECUTION WORKFLOW` / `DELIVERY CONTRACT` / `TOOL POLICY`。
- 动态历史：调 `shellMinimizer` / `compaction` / `snapcompact` 阈值。
- 更多 token 节省。

## 开发笔记

工作区笔记（规划、调研、架构）在 [`dev-notes/`](dev-notes/)：

- [`dev-notes/PLAN.md`](dev-notes/PLAN.md) — 需求计划
- [`dev-notes/AGENTS.md`](dev-notes/AGENTS.md) — 工作区规则
- [`dev-notes/docs/tool-structure.md`](dev-notes/docs/tool-structure.md) — 工具结构
- [`dev-notes/docs/system-prompt-structure.md`](dev-notes/docs/system-prompt-structure.md) — 系统提示词结构
- [`dev-notes/docs/research-1-*.md`](dev-notes/docs) — 精简调研

## 许可

继承上游许可，见 [LICENSE](LICENSE)。
