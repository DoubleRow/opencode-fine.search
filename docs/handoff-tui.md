# TUI 全文检索交接（P2）

> 生成于 2026-11-05，基线分支 `feat/p1-search-overlay`（HEAD `c988b02`，领先 `origin/main` 44+ 个提交，未推送）。
> 本文是给「下一位接手 TUI 实现的会话」的完整交接：现状、经验、任务书、验收。

---

## 1. 当前成果

### 1.1 已落地

| 层 | 内容 | 位置 |
| --- | --- | --- |
| 索引 | 旁路 SQLite + FTS5 trigram；覆盖全部历史会话片段 | `lib/extract.mjs`、`lib/index-db.mjs` |
| 同步 | 会话指纹增量同步，源库只读 | `plugin/worker.mjs`（`sync()` 调 `index-db`） |
| 检索 | L0 精确（trigram，≥3 字）+ 1–2 字 LIKE 兜底；BM25 + 段/会话 RRF | `lib/index-db.mjs` |
| RPC | `search` / `read` / `summary` / `stream` / `status` | `plugin/rpc.ts`、`plugin/index.ts`、`plugin/worker.mjs` |
| CLI | `status / sync / search / read / summary / stream / serve` | `bin/oc-search`、`plugin/worker.mjs` |
| GUI | 标题栏入口、非模态浮层、右侧详情栏、整段只读回放 | `plugin/gui.tsx` 等 |
| 质量 | 56 项 `node:test`；`oxlint` 0 告警；`tsc --noEmit` | `tests/`、`package.json` |

### 1.2 关键数字（实查）

- 索引：44 个会话 / 6,652 条消息 / 13,034 个片段。
- 最大单会话 1,397 片段；最大单片段 53,860 字；全库 `data:` URI 约 324 MB 已排除。
- 搜索冷启动约 1.4s（sidecar 打开 + 同步），热查询 8–90ms；`stream` RPC 实测 2–5ms。
- GUI 产物 `plugin/dist/gui-experimental.cjs` 约 54 kB。

### 1.3 RPC 速查

```ts
import { SearchRpc } from "./rpc.ts";
const api = context.client.rpc(SearchRpc); // TUI 里同样可用（已核实官方文档）
```

| 方法 | 入参 | 出参要点 |
| --- | --- | --- |
| `search` | `query, limit, offset, includeReasoning, includeTools` | `mode, terms, candidates, items[]` |
| `read` | `segmentId` | 完整正文 `text` |
| `summary` | `sessionId` | 项目、当时在做、解决、来源 |
| `stream` | `sessionId, offset?, limit?, anchorSegmentId?, maxChars?` | `total, offset, anchorIndex, hasMore, items[]` |
| `status` | — | 索引就绪状态与计数 |

`SearchOutputItem`：`segmentId, sessionId, messageId, kind, ts, title, directory, snippet, matchStart, matchEnd, score`。

---

## 2. 开发经验（踩过的坑）

### 2.1 数据层

- **源库只读**：`new DatabaseSync(path, { readOnly: true })`。索引写独立文件
  `~/.local/share/opencode-oc-search/index.db`（600，可删可重建）。
- **索引缺失/损坏必须显式报错**，禁止返回「看似成功的空结果」。
- **排除重内容**：`data:` URI、`write.content`、`edit.oldString/newString`、snapshot、diff。
  否则索引会膨胀到无法接受。
- **同步按消息指纹增量**，不要全量重建；删除消息/会话要同步清理。
- **摘要降级**：`opencode-mem` 的 4747 接口只读、可失败；失败退回自动摘要，不阻塞。
- **语义检索尚未实现**：当前 `search` 只有 FTS/LIKE；不要把它误写成「已支持语义」。

### 2.2 分页与流

- `stream` 固定 40 条/页（服务端上限 80），服务端单条截断 4000 字，客户端显示再截 2000 字。
- 锚点：`anchorIndex = count(id <= anchor) - 1`；首页从 `anchorIndex - limit/2` 开始。
- 翻页必须**按已加载条数**推进：`after = offset + items.length`；`before = max(0, offset - pageSize)`。
  用 `offset + pageSize` 会在混入 before 页后错位。
- 合并去重按 `segmentId` 升序；`before` 加载后要补偿 `scrollTop`，否则视口跳动。
- 空会话：`total = 0` 要显示空态，不能永久停在「加载中」。
- 切换会话/命中时必须复位 `busy`、`loadingText`；旧请求靠 token 丢弃，但 `finally` 不会再执行。

### 2.3 GUI 交互（TUI 同样适用）

- 全屏 fixed 容器必须 `pointer-events: none`，只有遮罩和卡片可点；遮罩要给侧栏让位。
- 判断面板是否可见用 `layout.state === "visible"`，不要用 DOM 宽度（收起后元素仍在）。
- 方向键只在焦点位于搜索卡片内时接管，否则会抢侧栏滚动。
- 宿主拖拽侧栏时会给 `body` 设 `user-select: none`，面板根节点要显式 `user-select: text`，
  按钮/导航保持 `none`。
- 「预览 ↔ 回放」保留离场层做交叉淡入（约 240ms），尊重 `prefers-reduced-motion`；
  不要硬切。
- 详情栏的当前命中用 `selection.index`，**不要固定取 `hits[0]`**；换条命重要重置回放状态。
- 预览固定 20 行；全文只走只读回放，不再提供「展开全部」。

### 2.4 工程

- 每个任务独立分支；commit `type(scope): 中文描述`；**不 push**。
- 改动后固定跑：`pnpm typecheck` → `pnpm lint` → `pnpm test`。
- 纯逻辑抽到 `*-model.ts`（不依赖 DOM），用 `node:test` 覆盖；UI 只做薄壳。
- `oxlint` 只做检查，不启用格式化；不要顺手修历史告警。
- 已知限制：OpenCode 原文可能已被截断（本机 68 处）；V1 旧表 `message`/`part` 未纳入；
  GUI/TUI 插件 API 仍可能随版本变化。

---

## 3. TUI 任务书

### 3.1 目标

让 TUI 里也能对全部历史会话做全文检索：快捷键 → 搜索 → 结果列表 + 预览 → 打开会话/只读回放。

**复用现有 RPC 与纯逻辑，不重写检索核心，不新增运行时依赖。**

### 3.2 已核实的 TUI 插件事实

- 入口：`@opencode/plugin/tui` 的 `Plugin.define({ id, setup(context) })`。
- 客户端：`context.client.rpc(SearchRpc)` 可直接调用本插件已注册的 RPC。
- 命令/键位：`context.keymap.layer(() => ({ mode: "global", commands: [...] }))`，
  支持 `palette` 与 `slash`。
- 对话框：`context.ui.dialog.show(() => JSX, onClose)`，`dialog.set({ size, centered })`，
  内置 `alert/confirm/prompt/select`。
- 路由/标签：`context.ui.router.navigate({ type: "session", sessionID })`；
  `context.ui.tabs.focus(sessionID)`（标签页启用时）。
- 面板：`context.ui.panel.open("fine.search", { presentation })` + `session.panel` slot。
- 主题/渲染：`context.theme`、OpenTUI 元素 `<box> <text> <input> <scrollbox> <select>`。

官方文档（实现前先读，别猜键位语法）：

- TUI 插件：https://opencode.ai/v2/docs/build/plugins/cli
- RPC：https://opencode.ai/v2/docs/build/plugins/rpc
- CLI 键位：https://opencode.ai/v2/docs/cli/keybinds

### 3.3 交互设计（建议）

1. **入口**：命令 `fine.search.open`，`palette: true`，`slash: { name: "finesearch", aliases: ["fs"] }`；
   键位先查文档与 `~/.config/opencode/cli.json` 现有绑定，避免冲突。**以 palette/slash 为兜底**。
2. **搜索框**：自定义 dialog（`xlarge`），顶部 `<input>`，100–120ms 防抖，旧请求按 token 丢弃。
3. **结果列**：左侧 40%，按会话分组，显示标题/项目/时间/命中片段；`↑↓` 选择，`PgUp/PgDn` 翻页。
4. **预览列**：右侧 60%，显示项目、会话标题、摘要、命中原文（20 行，命中词高亮）；
   `Tab` 切换为只读回放（`stream` 分页、思考默认收起、单条 2000 字截断、顶部「只读回放」）。
5. **打开**：`Enter` 打开命中会话并关闭 dialog；`Esc` 只关 dialog；`Ctrl+C` 等宿主键不要抢。
6. **空/错/加载**三态必须都有；索引未就绪要提示，而不是空列表。

### 3.4 文件与阶段

新增：

```text
plugin/tui.tsx         TUI 入口：keymap + dialog + 视图
plugin/tui-model.ts    纯逻辑：过滤、选中步进、分页、截断（可单测）
plugin/tui-theme.ts    TUI 颜色/排版常量（可选）
tests/tui-model.test.mjs
docs/plan-tui-search.md 实现记录
```

修改：

- `plugin/package.json`：新增导出 `"./tui": "./tui.tsx"`；按需补 OpenTUI peerDependencies
  （`@opentui/core`、`@opentui/solid`、`solid-js`，仓库已安装）。
- `package.json`：仅在需要时加 `typecheck:tui` 脚本。

阶段（每阶段一个 commit）：

1. **Spike**：`./tui` 导出 + 命令 + dialog 能弹 + 调通 `status`/`search`。
   先解决 TSX 命名空间：TUI 文件建议 `/** @jsxImportSource @opentui/solid */`，
   或加 `plugin/tsconfig.tui.json`；确保 `pnpm typecheck` 能识别 `<box>/<text>`。
2. **搜索列表**：防抖、分组、键盘导航、三态。
3. **预览**：`summary` + `read`，20 行、高亮。
4. **只读回放**：`stream` 分页、锚点、思考收起、截断展开。
5. **打开与打磨**：`router.navigate`/`tabs.focus`、空态、快捷键提示、文档。

### 3.5 验收

```bash
cd /path/to/opencode-fine.search
pnpm typecheck
pnpm lint
pnpm test
# 交互（需要用户在真实终端里验，不要试图自动化 TUI）
opencode
```

- 命令面板出现「全文检索」，slash `/finesearch` 可用。
- 搜一个跨会话关键词，结果可选中、预览正确、Enter 打开对应会话。
- 回放能翻页、锚点定位、思考收起、超长条目可展开。
- GUI 现有功能不回归（`pnpm build:gui` 仍通过）。
- 新增纯逻辑有单测；`pnpm test` 全绿。

### 3.6 红线

- 不写 `opencode.db`；索引只写旁路库。
- 不新增运行时依赖；新依赖只能是 devDependency，且需先说明。
- **不改** `~/.config/opencode/opencode.json`：该插件已以本地路径注册，
  加 `./tui` 导出即可自动加载 TUI 部分。
  若确实需要 `cli.json`，先备份并征求用户同意。
- 不删 `docs/feasibility-search-ui.md`；不动 GUI 的既定交互。
- 不 `git push`，不重写历史，不合并分支。
- 启动新分支：`git switch -c feat/p2-tui`（从当前 HEAD）。

---

## 4. 已知待办（非本任务）

- P3 语义 lane：`opencode-mem /api/search` 只读接入 + 降级（当前未实现）。
- 工具名/diff 的上下文增强（`session.context`）。
- `panel.tsx` 预览分支的 JSX 缩进整理（纯格式）。
- 分支尚未推送；需要时由用户执行 `git push -u origin feat/p1-search-overlay`。