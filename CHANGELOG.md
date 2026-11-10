# 变更记录

## 未发布

### 修复

- **CLI `oc-search`**：`--limit abc` / `--limit 0` / 选项缺值不再静默回退默认，统一按用法错误返回 2；
  检索改为流式 `iterate()` 并把类型、会话、目录、日期条件下推到 SQL，避免全量载入消息正文导致内存暴涨。
- **索引就绪状态**：FTS 查询失败只在「查询被 trigram 拒绝」时降级 LIKE，磁盘/索引损坏改为向上抛错，
  不再伪装成空结果；sidecar 的「索引未就绪」改为结构化 `not_ready { reason }` 返回前端。
- **增量同步**：统一使用 `fingerprintOf` 生成消息指纹，消除 worker 与 `lib/extract.mjs` 的两份口径。
- **RPC 超时**：单次调用 30s 未响应即终止 sidecar 并在下次调用时重建，避免请求永久悬挂。
- **GUI/TUI 竞态**：切换命中时立即作废在途的摘要/原文/展开请求；切换命中后旧全文不再写进新状态；
  已在本页再次 `/fs <关键词>` 会真正执行新检索，而不是被忽略。
- **错误可见性**：复制原文、展开全文失败都会弹出错误提示，不再静默吞掉。
- **AGENTS.md**：结构说明与实际文件对齐（`lib/summary.mjs`，同步与协议内嵌于 `plugin/worker.mjs`）。

## 1.0.0 — 2026-11-05

### 维护

- 类型依赖 `@opencode/client` / `@opencode/plugin` / `@opencode/theme` 由 2.2.5 升至 2.2.6，插件 `peerDependencies` 同步；
  无业务改动，GUI 产物字节不变。2.2.6 的类型变更为纯新增（`Panel.width`、`CodeBlock`、`Ui.Select`、
  `Ui.SettingsLayout`、`Theme` 等），本项目未接用。

## 1.0.0 — 2026-11-05

首个同时提供 **Desktop GUI** 与 **TUI** 的版本。

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