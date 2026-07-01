# `systemd --user` 工具整体规划

## 背景

目标是在 `oh-my-pi` 里新增一个 **面向长时任务的 `systemd --user` 工具**，用于深度学习/训练/推理这类需要：

- 脱离当前 TUI/CLI 持续运行
- 可查询状态
- 可追踪日志
- 可停止/清理
- 可设置基本资源限制

的场景。

这不是现有 `job`/`async bash` 的替代品，而是一个 **OS 级持久作业托管工具**。

---

## 问题定义

现有能力分两类：

1. **会话内后台任务**
   - `bash async:true`
   - `job list/poll/cancel`
   - 生命周期跟当前 agent/session 绑定

2. **工具执行类能力**
   - `bash` / `eval` / `task` / `ssh`
   - 适合一次执行，不适合作为长时托管

它们都不适合以下需求：

- 关闭 TUI 或断开 terminal 后继续跑
- 用 `systemctl --user` / `journalctl --user` 管理
- 用 transient unit 承载数小时到数天的训练任务

因此需要一个新的、边界明确的工具。

---

## 设计结论

### 推荐方案

新增一个独立内建工具：**`systemd`**。

它只管理 **user 级 systemd transient service**，不进入现有 `job` 语义。

### 不推荐方案

- 不把 `systemd` 强塞进 `job.ts`
- 不把 `systemd` 任务伪装成 `async bash`
- 不新起一个自维护 daemon
- 不第一版就做 GPU 调度器 / 分布式队列 / 多机编排

---

## 工具边界

### 这个工具负责

- `systemd-run --user` 提交 transient service
- `systemctl --user` 查询 unit 状态
- `journalctl --user` 查看日志
- 停止指定 unit
- 枚举本工具创建的 units

### 这个工具不负责

- 代替现有 `job` 工具
- 代替 Slurm / K8s / Ray
- 自动做复杂 GPU 排队
- 自动 checkpoint/requeue
- 跨机器调度

---

## 建议的工具接口

建议采用和 `github` / `debug` 类似的 **op-based** 设计。

### 工具名

- `systemd`

### 第一版 op

- `submit`
- `status`
- `logs`
- `stop`
- `list`

### 建议输入草案

```ts
{
  op: "submit" | "status" | "logs" | "stop" | "list",
  unit?: string,
  command?: string,
  cwd?: string,
  env?: Record<string, string>,
  memory?: string,
  cpuQuota?: string,
  gpu?: string,
  lines?: number,
  description?: string,
  remainAfterExit?: boolean
}
```

### 语义建议

#### `submit`
返回：

- unit 名
- 是否成功进入 active/activating
- 提交命令摘要
- 后续操作提示（`status/logs/stop`）

#### `status`
返回：

- `ActiveState`
- `SubState`
- `MainPID`
- `ExecMainStatus`
- `FragmentPath`（如果有）
- 时间信息

#### `logs`
返回：

- `journalctl --user -u <unit>` 的文本结果
- 支持末尾若干行

#### `stop`
返回：

- stop 是否成功
- unit 当前状态

#### `list`
返回：

- 当前用户下由本工具创建的 units 列表
- active / failed / exited 概览

---

## 与现有架构的关系

### 与 `job` 的关系

- `job` 是 **会话内异步句柄管理**
- `systemd` 是 **OS 级持久 unit 管理**

两者有交集，但不是一层抽象。

建议：

- `systemd` 工具 **不要注册到 AsyncJobManager**
- `systemd submit` 成功后，直接返回 unit 信息
- 后续由 `systemd status/logs/stop` 管理，而不是 `job poll`

### 与 `bash` 的关系

不建议通过 `bash` 工具套壳实现；应直接在 `systemd.ts` 内部走专门的执行路径，避免把 tool-to-tool 调用耦死。

---

## 代码改动面

以下路径均相对 `oh-my-pi` 仓库根目录。

### 1. 新增工具实现

**必改**

- `packages/coding-agent/src/tools/systemd.ts`

职责：

- schema
- details 类型
- tool class
- `submit/status/logs/stop/list` 执行逻辑
- 必要的结果渲染

### 2. 新增模型侧工具说明

**必改**

- `packages/coding-agent/src/prompts/tools/systemd.md`

职责：

- 面向模型解释该工具的使用边界
- 强调它是 `systemd --user`，不是 system-wide
- 强调日志/状态查看方式
- 给出输入参数约束

### 3. 注册到内建工具列表

**必改**

- `packages/coding-agent/src/tools/builtin-names.ts`
- `packages/coding-agent/src/tools/index.ts`

具体包括：

- 在 `BUILTIN_TOOL_NAMES` 中加入 `systemd`
- 在 `tools/index.ts` 里 import/export `SystemdTool`
- 在 `BUILTIN_TOOLS` 注册表中加 `systemd: s => new SystemdTool(s)`

### 4. 设置开关

**推荐**

- `packages/coding-agent/src/config/settings-schema.ts`

建议新增：

- `systemd.enabled`
- `systemd.defaultSlice`（可选）
- `systemd.defaultMemoryMax`（可选）
- `systemd.defaultCpuQuota`（可选）

并在：

- `packages/coding-agent/src/tools/index.ts`

的 `isToolAllowed(name)` 中增加 gating。

### 5. 文档

**推荐**

- `docs/tools/systemd.md`

职责：

- 解释实现入口、关键协作者、行为语义、限制条件
- 和现有 `docs/tools/bash.md` / `docs/tools/job.md` 风格一致

### 6. 测试

**推荐**

新增测试文件：

- `packages/coding-agent/test/systemd-tool.test.ts`
- `packages/coding-agent/test/tool-discovery/initial-tools.test.ts`（补断言）

必要覆盖：

- 工具在启用/禁用 setting 下的可见性
- `loadMode` / `summary` 完整性
- `submit/status/logs/stop/list` 的参数校验
- 非 Linux / 无 user systemd 环境时的报错
- `systemd-run` 返回错误时的错误传播

---

## 关键架构节点

### 工具主目录

- `packages/coding-agent/src/tools/`

### 内建工具注册

- `packages/coding-agent/src/tools/index.ts`

### 内建工具名联合类型

- `packages/coding-agent/src/tools/builtin-names.ts`

### ToolSession 注入点

- `packages/coding-agent/src/tools/index.ts`
- `packages/coding-agent/src/sdk.ts`

### session 组装工具链

- `packages/coding-agent/src/sdk.ts`

### 现有 async/job 体系

- `packages/coding-agent/src/async/job-manager.ts`
- `packages/coding-agent/src/tools/job.ts`
- `packages/coding-agent/src/tools/bash.ts`

---

## 平台与环境约束

第一版建议明确限制：

- **仅支持 Linux**
- **仅支持 user-level systemd**
- 若 `systemctl --user` 不可用，直接报错
- 若 user manager 不在 running 状态，直接报错

建议运行时检查：

- `systemctl --user is-system-running`
- 必要时检查 `loginctl show-user $USER -p Linger --value`

但 `linger` 不必作为硬阻塞：

- 没开 linger 也可以提交任务
- 只是不能保证 logout 后持续存在

---

## 数据与命名建议

### unit 命名

建议统一前缀，例如：

- `omp-job-<timestamp>-<suffix>`
- 或 `pi-job-<timestamp>-<suffix>`

要求：

- 可预测
- 可筛选
- 便于 `list` 仅展示本工具创建的 unit

### metadata

第一版可以先 **不做本地 metadata 文件**，只依赖 unit name + systemd 查询。

如果后续要增强，可再引入：

- `~/.local/state/.../jobs/*.json`

保存提交参数、标签、工作目录等。

---

## 日志策略

建议第一版直接依赖 journald：

- `journalctl --user -u <unit>`

不自造日志文件轮转。

工具职责只是：

- 控制读取行数
- 控制是否 follow（第一版可不做 follow）
- 把结果格式化成 tool output

---

## 资源限制建议

建议第一版只支持少量、最稳定的限制项：

- `MemoryMax`
- `CPUQuota`
- `WorkingDirectory`
- `Environment`
- `Type=exec`

GPU 建议先做成轻语义：

- `gpu: "0"` → 写入 `CUDA_VISIBLE_DEVICES=0`

先不要做：

- GPU 锁
- 显存探测
- 自动排队

---

## 推荐 rollout 顺序

### Phase 1：最小可用

- `systemd.ts`
- `systemd.md` prompt
- 注册进 `BUILTIN_TOOLS`
- `submit/status/logs/stop/list`
- Linux 环境检查

### Phase 2：可配置

- `systemd.enabled`
- 默认资源限制 settings
- 更好的 unit 命名

### Phase 3：增强

- metadata 持久化
- 标签/筛选
- GPU 轻量占位能力
- 更丰富的日志分页与状态显示

## 配套实施清单

第一阶段的逐文件实施 TODO 已单独归档，便于后续直接照单落地：

- `/home/jin/pi/docs/systemd-user-tool-phase1-todo.md`

该清单已补充以下实现级结论：

- `systemd` 必须新增独立 tool schema，而不只是注册工具名
- schema 建议定义在 `packages/coding-agent/src/tools/systemd.ts`
- 第一版应补 approval 分级：`list/status/logs` 为 `read`，`submit/stop` 为 `exec`
- 第一阶段必改文件、建议一起改的文件、以及明确不改的文件列表

---


## 风险点

1. **和现有 `job` 语义混淆**
   - 必须在 prompt 和文档里明确区分

2. **跨平台行为差异**
   - 必须在代码里显式限制 Linux/systemd

3. **secondary top-level session 行为**
   - 现有 async manager 有 session owner 问题
   - systemd tool 若独立实现，可绕开这层复杂性

4. **日志输出过长**
   - 要复用现有 truncation / artifact 策略

5. **命令注入/参数转义**
   - `systemd-run` 命令拼接必须严格处理
   - 尽量避免让用户传完整 shell 片段再层层嵌套

---

## 最终建议

在 `oh-my-pi` 中，把这个能力实现成一个 **新的 discoverable built-in tool：`systemd`**，而不是扩展 `job`。

第一版目标应当非常克制：

- 只做 user-level transient service
- 只做单机持久任务管理
- 只做最关键的 5 个 op
- 不把自己做成调度器

这样能最大化复用仓库现有工具架构，同时最小化和 async/job 体系的冲突。
