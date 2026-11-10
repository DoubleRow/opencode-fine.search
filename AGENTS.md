# opencode-fine.search — 项目规范

> 优先级：本文件 > `~/.config/opencode/AGENTS.md`（全局）> 模型默认行为。

## 目标

把 OpenCode 本地会话库变成**可在 app 内检索的资产**：
对 agent 记录过的所有文字做精确/模糊检索，点击结果直接定位到原文。

产出形态：

1. **GUI 插件**（OpenCode Desktop，优先）——标题栏入口 + 搜索弹窗 + 原文面板。
2. **TUI 插件**（后续）——复用同一 RPC，只换表现层。
3. **CLI `bin/oc-search`**（保留）——同一套检索核心，便于脚本与验收。

## 红线

1. **会话库只读**：一律 `new DatabaseSync(path, { readOnly: true })`。禁止写 `opencode.db`、ALTER、VACUUM、迁移。
   本项目的索引写在独立旁路库，见「结构」。
2. **不联网**：不向外部服务发送会话内容。语义检索只允许访问本机
   `127.0.0.1:4747`（opencode-mem），其 token 只由 server 进程读取，禁止出现在日志、返回值、前端。
3. **索引期与查询期零 LLM 调用**：抽取、分词、排序全部确定性；语义 lane 只调用本机向量接口。
4. **不改全局配置**：`~/.config/opencode/opencode.json`、`opencode-mem.jsonc` 只读参考。
   需要登记插件时，先备份并单独征求同意。
5. **运行时不新增依赖**：索引/检索只用 Node 内置模块（`node:sqlite`、`node:fs`、`node:child_process`）。
   允许的依赖仅限 `devDependencies`（打包与类型）。

## 索引范围（已定）

- 覆盖**全部历史会话**（含子会话、挂起会话）。
- 入库：`user.text`、`assistant.text`、`reasoning`（默认隐藏）、`tool.input`、`tool.output`、
  `system`、`synthetic`、`compaction.summary`。
- **排除**：`data:` URI（本机实测 324 MB）、`write.content`、`edit.oldString/newString`、
  `snapshot`、diff、模型元数据。

## 结构

```
bin/oc-search          CLI 启动器（sh）
bin/oc-search.mjs      CLI 实现（直接读会话库，独立于旁路索引）
lib/extract.mjs        消息 → 片段、数据 URI 清洗、增量指纹
lib/index-db.mjs       FTS5 schema / 建库 / 检索 / 回放（含 query 与排序）
lib/summary.mjs        会话摘要（本项目 + opencode-mem 记忆合并）
plugin/                OpenCode 插件（server + GUI + TUI）
plugin/worker.mjs      Node sidecar（node:sqlite）：同步、RPC 协议与 CLI 分发
tests/                 node --test
```

> 注：增量同步（`sync`）与 stdio JSON-RPC 协议目前内嵌在 `plugin/worker.mjs`，
> 尚未拆成独立的 `lib/sync.mjs` / `lib/protocol.mjs`。

旁路索引：`~/.local/share/opencode-oc-search/index.db`（权限 600，可删可重建）。

## 检索约定

- L0 精确：FTS5 trigram（≥3 字符）；1–2 字符走 `LIKE` 兜底。
- L1 排序：BM25 + 段/会话 RRF(k=60)。
- L2 语义：opencode-mem `/api/search`，只读、可降级，结果标注 lane。
- 索引缺失/损坏必须显式报状态，**禁止返回「看似成功的空结果」**。

## 验收

改动后必须贴真实输出，不能口头断言：

```bash
pnpm typecheck
pnpm test
./bin/oc-search 连接池 --limit 3      # 应命中
./bin/oc-search 向量                   # 2 字查询应走 LIKE 并命中
./bin/oc-search 不存在的词xyz          # 应输出「没有命中」且退出码 1
```

GUI 验收：`⌘⇧G` → 输入 → Enter → 会话打开 + 面板高亮命中原文。

## Git

- 每个任务独立分支，不直接改 `main`。
- commit：`type(scope): 中文描述`，`type ∈ feat/fix/docs/test/chore`。
- **`git push` 仅在人工明示后执行**，不自动推送。

## 代码约定

- 异步/异常不吞：失败要带路径与原因。
- 参数解析拒绝未知选项，返回码 2。
- 输出默认给人看，`--json` 给机器看。
- 中文输出，字段名英文。