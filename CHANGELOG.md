# 变更记录

版本号遵循 [Semantic Versioning](https://semver.org/)：`MAJOR.MINOR.PATCH`，修复与兼容性改进走 PATCH，
新增能力走 MINOR，破坏性变更走 MAJOR。每个正式版本发布时同步更新 `package.json` 与 `plugin/package.json`
的 `version`，并把「未发布」段落切成带日期的版本标题。条目按 `新增 / 变更 / 修复 / 移除 / 性能 / 文档` 归类。

## 1.1.1 — 2026-11-26

修复：适配宿主 2.4.0 的 `session_part` 行式存储。检索逻辑、排序、片段格式一律未变。

### 修复

- **适配 `session_part` 行式存储**（宿主 2.4.0 起 assistant 消息正文改存 part 行，
  `content` 恒为空数组）：抽取改为双源——优先读 part 行（text → assistant、
  reasoning → reasoning、tool → tool），part 为空时回退原内联 `content` 路径，
  内联输出与旧实现逐字节一致。
- **水位五元组**：session 维度在 `count / max(seq) / max(time_updated)` 基础上新增
  `part_count / part_max_updated`，part 行流式落库（消息行 time_updated 随之推进）
  的会话能被 L1 识别并重抽。
- **gap 可观测**：content 与 part 均为空的消息计入 gap，`sync` 输出与 `status`
  新增 `partRows` / `gaps` 字段；gap > 0 时 CLI 输出黄色提示（可能是存储格式变化）。
- schema 升到 v4：`session` 新增 `part_count` / `part_max_updated`，写打开时原地迁移。

## 1.1.0 — 2026-11-19

索引架构 v3：把「每次同步扫全库」换成三级变更检测，并给写入加双模式。
检索逻辑、排序、片段格式一律未变。

### 新增

- **三级变更检测（L0/L1/L2/L3）**：源库文件指纹不变即返回；按会话聚合
  `count / max(seq) / max(time_updated)` 筛出变化的会话；只对变化会话逐条比对消息水位；
  只对真正变化的 id 读正文并重切片段。删除只比对变化会话的 id 集合。
- **双模式写入**：待处理改动 ≥ `2000`（`OC_SEARCH_REBUILD_THRESHOLD` 可覆盖）、索引为空、
  或刚完成 schema 迁移时走重建——写 `<索引>.new`、校验计数、原子 `rename` 换代、`gen + 1`；
  失败则删半成品、保留旧索引。其余情况每批 500 条就地补丁。
- **`status` 新增字段**：`gen`、`lastSyncMs`、`lastSyncSkipped`、`sourceSig`；`sync` 输出区分
  「空转跳过 / 增量 / 重建」。

### 变更

- schema 升到 v3：`session` 新增 `seq_max` / `msg_count` / `last_msg_updated`，`message` 新增 `seq`。
  v1 / v2 索引在写打开时原地 `ALTER` 迁移（失败整体回滚并保留原版本），随后自动重建一次补齐水位。
  只读打开仍接受 v1 / v2，升级前后状态查询不中断。
- 重建按 `(message_id, ordinal)` 沿用旧片段 id：重建与迁移前后 `segmentId` 不变，
  GUI / TUI 里已打开的定位锚点不会失效。

### 性能

- 空转同步：**330–432 ms → 1 ms**（新进程读 meta）/ **0 ms**（进程内缓存，零查询）。
- 小增量：**≈47 ms/条 → 86 ms / 2 条、151 ms / 19 条**。
- 全量重建（19,000 段）：tmpfs **17.5 s**；机械盘 **18.7 s**（改动前同一份数据、同一版本代码为 55.8 s，
  重建临时库关闭回滚日志与 fsync 后追平）。

### 测试

- 新增 `tests/sync-v3.test.mjs` 7 项：空库建库、L0 跳过且不写、单会话增量、消息改写替换、
  消息/会话删除、阈值触发重建（并与增量路径逐字段比对）、v2 → v3 迁移（含片段 id 稳定）。
- 门禁 **97 项全绿**：`typecheck` 无输出、`lint` 0 告警、`test` 97 pass / 0 fail。

### 文档

- 新增 `docs/plan-index-v3.md`：三张闸门职责、双模式阈值与理由、schema v3 DDL、
  性能预算与实测、失效模式对策。

## 1.0.3 — 2026-11-16

对齐 OpenCode 2.3.0：SDK 类型依赖与连带 peer 升级，插件 API 无破坏性变更，本机宿主已是 2.3.0。

### 维护

- 类型依赖 `@opencode/client` / `@opencode/plugin` / `@opencode/theme` 由 2.2.7 升至 2.3.0。
- 连带升级 peer 链：`@opentui/core` / `@opentui/solid` 0.8.2 → 0.8.4（`plugin@2.3.0` 要求 `>=0.8.4`），
  `effect` 4.0.6 → 4.1.0（`client@2.3.0` 要求精确 `4.1.0`）；插件 `peerDependencies` 同步为
  `@opencode/plugin` `2.3.0`、`@opentui/*` `>=0.8.4`。
- 本插件依赖的三个入口 `Plugin.define`、`ctx.rpc.register`、`ctx.event.subscribe` 类型签名未变；
  `dist/gui/*.js` 与 2.2.7 逐字节一致，GUI 产物 `dist/gui-experimental.cjs` 保持 55.91 kB
  （sha256 `99a8ad4e…` 前后相同）。
- 2.2.7 → 2.3.0 的 API 变更为增量：会话请求消息增加只读 `metadata`、工具上下文新增 `cancel` 协作停止信号、
  OAuth `integration.submit` 透传粘贴的跳转 URL、图标集新增 `outline-maximize`；本项目均未接用，无需改代码。

### 测试

- 门禁保持 90 项全绿：`typecheck` 无输出、`lint` 0 告警、`test` 90 pass / 0 fail；`pnpm peers check` 无残留告警。

## 1.0.2 — 2026-11-12

对齐 OpenCode 2.2.7：类型依赖升级，插件 API 无破坏性变更，运行时行为不变。

### 维护

- 类型依赖 `@opencode/client` / `@opencode/plugin` / `@opencode/theme` 由 2.2.6 升至 2.2.7，
  插件 `peerDependencies` 同步；GUI 产物字节不变（`dist/gui-experimental.cjs` 55.91 kB）。
- 2.2.7 的插件 API 变更为纯新增：`experimental.model.resolve` hook（单次请求前可改写所用模型，
  用于 Copilot Auto 之类的路由模型），本项目未接用，类型与行为均未受影响。
- 2.2.7 已知运行时变化（不涉及本插件）：`rpc.call` / `artifact.*` / `integration.list` 等端点不再等待
  插件加载完成，插件提供的条目改为在加载完成后由 `*.updated` 事件补上。
- 桌面端侧栏标签新增 `⌘W` 关闭、`⌘⇧T` 重开、右键「关闭右侧标签」；本插件的详情栏按普通侧栏标签使用，
  无需改动。

### 测试

- 门禁保持 90 项全绿：`typecheck` 无输出、`lint` 0 告警、`test` 90 pass / 0 fail。

## 1.0.1 — 2026-11-10

一次代码审查 + 交互回归后的修复版本：CLI 输入校验与内存占用、索引就绪语义、RPC 超时、
GUI / TUI 的滚动跟随与回放宽度，以及首尾导航行为统一。

### 修复

- **CLI `oc-search` 输入校验**：`--limit abc` / `--limit 0` / 选项缺值不再静默回退默认值，
  统一按用法错误退出（返回码 2），并补了对应测试。
- **索引就绪状态**：FTS 查询失败只在「查询被 trigram 拒绝」时降级 LIKE，磁盘 I/O、索引损坏改为向上抛错，
  不再伪装成空结果；sidecar 的「索引未就绪」改为结构化 `not_ready { reason }` 返回前端。
- **增量同步**：统一使用 `fingerprintOf` 生成消息指纹，消除 `plugin/worker.mjs` 与 `lib/extract.mjs`
  的两份口径，并注明仅凭时间戳/长度判断的局限。
- **RPC 超时**：单次调用 30s 未响应即终止 sidecar 并在下次调用时重建，避免请求永久悬挂。
- **GUI / TUI 竞态**：切换命中时立即作废在途的摘要 / 原文 / 展开请求；切换命中后旧全文不再写进新状态；
  已在本页再次 `/fs <关键词>` 会真正执行新检索，而不是被忽略。
- **错误可见性**：复制原文、展开全文失败都会弹出错误提示，不再静默吞掉。
- **GUI 浮层列表滚动**：`↑↓` 切换结果时按选中行位置滚动列表，上下各留一个行高余量，选中项不再滚出可视区。
- **GUI 悬停抢选中**：行悬停改用 `onMouseMove`（滚动时行经过静止指针不再触发），自动滚动只服务键盘导航；
  重新打开浮层时把选中行滚回视野。
- **GUI 回放宽度自适应**：补齐 `min-width: 0` 链与 `overflow-wrap: anywhere`，回放正文 / 工具输出
  按详情栏宽度换行，不再被右侧裁掉。
- **GUI 回放滚动**：移除回放块的 `content-visibility`，避免换行后高度估算变化导致的滚动跳动；
  锚点定位只调整流列表自身 `scrollTop`，不再连带滚动外层容器。
- **TUI 列表滚动**：下移越界时窗口也留一行底部余量（与上移对称）；可视窗口改为从 `start + sel` 派生，
  终端变矮或结果变少时自动收敛，选中行不会再落到可见选框之外。
- **TUI 回放宽字符**：`displayWidth` 补齐 emoji（`U+1F000–1FAFF` 等）与零宽组合符的占位估算，
  回放换行宽度额外让出 1 格（`replayWidth`），避免行尾被终端裁掉。

### 变更

- **首尾导航不环回**：GUI 浮层 `stepIndex`、详情栏「上一条 / 下一条」、TUI `stepHits` 全部改为到边界停住，
  不再从最后一条跳回第一条。

### 性能

- **CLI 检索**：改为流式 `iterate()` 逐行读取，并把类型、会话、目录、日期条件下推到 SQL，
  避免全量载入 `session_message.data`（本机实测数百 MB）导致内存暴涨。
- **GUI 浮层测量**：去掉 600ms 常驻 `setInterval` 轮询，改为打开时补测 + `ResizeObserver` + 窗口 resize。

### 文档

- **AGENTS.md**：结构说明与实际文件对齐（`lib/summary.mjs`，同步与 RPC 协议内嵌于 `plugin/worker.mjs`）。
- **CHANGELOG.md**：合并重复的 `1.0.0` 段落，补齐本版本条目与发布约定。

### 测试

- 测试数 84 → 90：新增 CLI 参数校验（4 项）、指纹稳定性（1 项）、emoji/零宽宽度与滚动余量断言。

## 1.0.0 — 2026-11-05

首个同时提供 **Desktop GUI** 与 **TUI** 的版本。

### 维护

- 类型依赖 `@opencode/client` / `@opencode/plugin` / `@opencode/theme` 由 2.2.5 升至 2.2.6，插件 `peerDependencies` 同步；
  无业务改动，GUI 产物字节不变。2.2.6 的类型变更为纯新增（`Panel.width`、`CodeBlock`、`Ui.Select`、
  `Ui.SettingsLayout`、`Theme` 等），本项目未接用。

### 新增

- **GUI 非模态搜索浮层**
  - 会话标题行 `👓 全文` 入口，命令面板 / `Ctrl+Shift+G` 亦可打开；
  - 主界面不变暗、侧边栏保持可见；
  - `↑↓` / 悬停即时预览，`Enter` 打开会话，`Esc` 关闭；
  - 浮层按右侧详情栏是否展开自动避让宽度。
- **GUI 右侧详情栏**
  - 项目 / 时间 / 命中类型、会话标题、命中原文（默认 20 行可展开）；
  - 「当时在做 / 解决」摘要，来源徽标 `LLM` / `记忆` / `自动`；
  - 整段会话只读回放，分页加载。
- **TUI 全文检索页**
  - `<leader>f`、命令面板、`/finesearch`（`/fs`）三通道入口；
  - 占满主内容区的路由页，宽屏两栏、窄屏单栏自适应；
  - 键盘导航、筛选、思考显隐、只读回放分页；
  - `Enter` 在后台标签打开会话，`Esc` 返回原页面。
- **共享能力**
  - `summary` / `stream` RPC 与摘要来源优先级；
  - CLI 新增 `summary` / `stream` / `serve` 子命令。

### 改进

- 引入 `oxlint`（仅 devDependency），`pnpm lint` 作为门禁，当前 0 告警；
- 测试增至 84 项，覆盖 TUI 布局与导航纯函数；
- 索引同步按消息指纹增量执行，源库始终只读。

### 说明

- 语义检索（向量 lane）**未实现**，当前仅支持精确 / 模糊检索；
- 原生 `Ctrl+Shift+F` 搜索补丁默认关闭，避免与自建浮层重复入口；
- GUI / TUI 插件 API 仍为 experimental，OpenCode 升级后需回归。

## 0.1.0 — 2026-11-04

- 旁路 FTS5 索引、抽取规则、增量同步；
- RPC `search` / `read` / `status` 与 Node sidecar；
- CLI `oc-search`；
- Desktop 插件骨架与原生搜索正文补丁（后续默认关闭）。