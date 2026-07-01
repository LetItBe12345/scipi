# Agent 工具结构

> 范围：`scipi/packages/scipi-agent`。只讲工具的结构——工具由什么组成、怎么进上游请求体、怎么常驻/隐藏、涉及哪些文件。不讲 system prompt 的其它内容、动态历史、内部链接。

## 1. 工具的组成（三部分）

每个内置工具由三部分内容构成：

- **description**：工具怎么用（用法手册，如 `bash.md` 写 bash 的边界和参数用法）
- **parameters**：工具接受什么参数（JSON schema：字段名、类型、必填、枚举值）
- **system prompt 里的部分**：`system-prompt.md` 里讲这个工具的选型规则（用 X 不用 Y）和工具名清单

## 2. 这三部分在上游请求体的落点

| 落点 | 在哪个字段 | 来源文件 | 是什么 |
|---|---|---|---|
| ① description | `tools` 字段（每工具的 description） | `prompts/tools/*.md` | 工具怎么用 |
| ② parameters | `tools` 字段（每工具的 parameters schema） | 工具实现 `tools/*.ts` 里定义 | 工具接受的参数 |
| ③ system prompt 里的部分 | `instructions` 字段 | `system-prompt.md` 的 `TOOL POLICY` + `Tool Inventory` | 选型规则 + 工具名清单 |

注意：① 和 ③ 有重复——`bash.md` 讲过"用 search 不用 grep"，`TOOL POLICY` 也讲一遍。层 1 去重就是去这个（已做，提交 `8058d0dff`）。

## 3. 工具机制

- **31 个内置工具**，名字定义在 `tools/builtin-names.ts`。
- **discovery=all**（`tools.discoveryMode` 默认值，`config/settings-schema.ts:3583`）：核心工具常驻，其余隐藏。
- **核心常驻 8 个**：`read bash edit write find eval task web_search`（`tools/index.ts` 的 `DEFAULT_ESSENTIAL_TOOL_NAMES`），外加 `search_tool_bm25`（发现机制入口）。
- **隐藏逻辑**：`tools/index.ts` 的 `filterInitialToolsForDiscoveryAll` 把非核心内置 + MCP 工具藏起来，模型用 `search_tool_bm25` 按需搜出来用。`tool-discovery/mode.ts` 解析模式（`auto` 阈值 40 才隐藏；`all` 一律隐藏非核心）。`tool-discovery/tool-index.ts` 建 BM25 索引。
- **真实省 token**：样本会话 21 个工具全开 → discovery=all 后 9 个常驻，`tools` 字段 78591 → 34122 字符，**省 57%**。

## 4. 涉及文件

```
scipi/packages/scipi-agent/src/
├── tools/
│   ├── builtin-names.ts        # 31 个内置工具名
│   ├── index.ts                # DEFAULT_ESSENTIAL_TOOL_NAMES(8) + filterInitialToolsForDiscoveryAll
│   ├── read.ts bash.ts edit.ts write.ts eval.ts task.ts find.ts  # 核心工具实现
│   ├── search-tool-bm25.ts     # 发现机制入口工具
│   └── ...其它工具实现
├── tool-discovery/
│   ├── mode.ts                 # discoveryMode 解析（auto 阈值 40）
│   └── tool-index.ts           # BM25 索引、可发现工具描述
├── prompts/
│   ├── tools/
│   │   └── *.md                # 每个工具的 description（① 的来源）
│   └── system/
│       └── system-prompt.md    # TOOL POLICY + Tool Inventory（③ 的来源）
└── config/
    └── settings-schema.ts      # discoveryMode 默认 all、各工具 enabled
```

## 5. 工具相关的精简

- 层 1：`bash.md` desc 与 `TOOL POLICY` 去重（已做，提交 `8058d0dff`，省 ~260 token）。详见 `docs/research-1-dedup.md`。
