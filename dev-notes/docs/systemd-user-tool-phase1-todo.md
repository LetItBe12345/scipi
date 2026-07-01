# `systemd --user` 工具第一阶段实施 TODO

## 目标

第一阶段直接交付一个最小可用版本：在 `oh-my-pi` 中新增独立 built-in `systemd` 工具，只覆盖 `systemd --user` 的长时后台任务管理，不复用现有 `job` / `AsyncJobManager` 语义。

## 本阶段边界

- 只支持 `systemd --user`
- 只支持 transient service
- 只支持 5 个 op：`submit` / `status` / `logs` / `stop` / `list`
- 不接入 `AsyncJobManager`
- 不依赖本地 DB
- 不开放任意 `--property` 透传，只开放白名单字段

## Tool Schema 结论

- 必须为新工具新增独立参数 schema
- schema 应定义在 `packages/coding-agent/src/tools/systemd.ts`
- 形式参考现有 `github` / `debug` 的 op-based schema：
  - `const systemdSchema = type({ ... })`
  - `readonly parameters = systemdSchema`
  - `readonly strict = true`
- 这部分不能只改工具注册，不改 schema

建议第一版 schema 字段：

- `op: "submit" | "status" | "logs" | "stop" | "list"`
- `unit?`
- `command?`
- `cwd?`
- `env?`
- `memory?`
- `cpuQuota?`
- `gpu?`
- `lines?`
- `description?`
- `remainAfterExit?`

语义校验建议放在 `execute()` 内按 op 再做一层：

- `submit` 必须有 `command`
- `status/logs/stop` 必须有 `unit`
- `list` 不应接受无关字段

## 必改文件

### 1. `packages/coding-agent/src/tools/systemd.ts`

- [ ] 新增 `SystemdTool` 实现
- [ ] 定义 `systemdSchema`
- [ ] 增加 `name` / `label` / `summary` / `loadMode` / `parameters` / `strict`
- [ ] 增加 `submit` / `status` / `logs` / `stop` / `list` 的 op dispatch
- [ ] 增加 Linux / user systemd 环境检查
- [ ] 直接调用 `systemd-run --user` / `systemctl --user` / `journalctl --user`
- [ ] 实现输出格式化与错误传播

### 2. `packages/coding-agent/src/prompts/tools/systemd.md`

- [ ] 新增模型侧工具说明
- [ ] 明确这是 `systemd --user`，不是 system-wide
- [ ] 明确它不是 `job` 的替代品
- [ ] 说明适合长时后台任务
- [ ] 说明 `status/logs/stop/list` 的使用边界

### 3. `packages/coding-agent/src/tools/builtin-names.ts`

- [ ] 把 `"systemd"` 加入 `BUILTIN_TOOL_NAMES`

### 4. `packages/coding-agent/src/tools/index.ts`

- [ ] `export * from "./systemd"`
- [ ] 在 `BUILTIN_TOOLS` 中注册 `systemd: s => new SystemdTool(s)`
- [ ] 在 `isToolAllowed(name)` 中加入 `systemd.enabled` gating

### 5. `packages/coding-agent/test/systemd-tool.test.ts`

- [ ] 新增工具单测
- [ ] 覆盖 schema / 参数校验
- [ ] 覆盖 op dispatch
- [ ] 覆盖非 Linux / 无 user systemd 环境报错
- [ ] 覆盖命令失败时的错误传播

### 6. `packages/coding-agent/test/tool-discovery/initial-tools.test.ts`

- [ ] 补 `systemd` 的 `loadMode` / `summary` 覆盖
- [ ] 确保 discoverable tool 元数据检查通过

## 建议第一阶段一起改

### 7. `packages/coding-agent/src/config/settings-schema.ts`

- [ ] 新增 `systemd.enabled`
- [ ] 如需要，预留后续可扩展字段：
  - [ ] `systemd.defaultMemoryMax`
  - [ ] `systemd.defaultCpuQuota`
  - [ ] `systemd.unitPrefix`
  - [ ] `systemd.maxLogLines`

### 8. `docs/tools/systemd.md`

- [ ] 新增实现文档
- [ ] 记录入口文件、调用链、边界和限制
- [ ] 明确与 `job` / `bash` 的区别

## 审批与权限建议

建议在 `systemd.ts` 第一版就加 op 级 approval：

- [ ] `list` / `status` / `logs` → `read`
- [ ] `submit` / `stop` → `exec`

实现形式参考现有 `github` / `debug`：

- 按 `op` 分类只读与执行类操作
- 保留后续扩展更细权限模型的空间

## 当前明确不改的文件

本阶段不建议改：

- `packages/coding-agent/src/tools/job.ts`
- `packages/coding-agent/src/async/job-manager.ts`
- `packages/coding-agent/src/tools/bash.ts`
- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/index.ts`

原因：第一阶段应保持 `systemd` 为独立 built-in tool，避免和会话内 async/job 生命周期混淆。

## 推荐实施顺序

1. [ ] 先实现 `systemd.ts` 最小骨架与 schema
2. [ ] 先打通只读 op：`status` / `logs` / `list`
3. [ ] 再补执行 op：`submit` / `stop`
4. [ ] 接入 `builtin-names.ts` / `tools/index.ts`
5. [ ] 接入 `systemd.enabled` setting
6. [ ] 补 prompt 文档与实现文档
7. [ ] 补测试并验证 discoverable tool 链路

## 归档说明

- 主规划文档：`/home/jin/pi/docs/systemd-user-tool-plan.md`
- 本实施清单：`/home/jin/pi/docs/systemd-user-tool-phase1-todo.md`
