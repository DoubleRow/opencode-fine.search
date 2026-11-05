# TUI 全文检索（P2）· 实现记录

> 状态：P2 已从「112 列对话框」改为**独立路由页**，自动化门禁全绿；界面用 tmux 伪终端实跑过。
> 承接：`docs/handoff-tui.md` §3.4 分阶段计划
> 复用：`SearchRpc`（server 插件）、`overlay-model` / `stream-model` / `panel-model` 纯函数

## 1. 交付物

| 文件 | 作用 |
| --- | --- |
| `plugin/tui.tsx` | TUI 插件入口：注册路由页 + 三通道命令，不再含任何界面逻辑 |
| `plugin/tui-page.tsx` | 路由页：左栏检索、右栏照搬 GUI 详情侧栏（摘要 / 原文 / 回放） |
| `plugin/tui-model.ts` | 纯逻辑：布局换算、分组、导航、预览裁窗、回放行、打开会话通路 |
| `plugin/package.json` | `"./tui"` 导出与 `@opentui/*`、`solid-js` 对等依赖声明 |
| `tests/tui-model.test.mjs` | 纯函数单测（含 `pageLayout` 四组尺寸断言） |

入口三通道：命令面板「全文检索（历史会话）」、斜杠 `/finesearch`（别名 `/fs`，支持 `/fs 关键词`）、键位 `<leader>f`。

## 2. 分阶段提交

| 阶段 | 提交 | 内容 |
| --- | --- | --- |
| S1 | `785f1f1` | `./tui` 导出 + 入口 + 对话框骨架 + status/search |
| S2 | `80c69b2` | 结果列表分组、键盘导航、筛选三态 |
| S3 | `955fba5` | 预览列：会话摘要 + 命中原文 + 词高亮 |
| S4 | `e3df66e` | 只读回放分页、思考收起、Ctrl+J 展开全文 |
| S5 | `0f7460e` | Enter 打开会话、空态/错误态/未就绪态收尾 |
| S6 | `c748e8a` | 真机验收修渲染缺陷（span / 选中态 / CJK 截断） |
| S7 | 本次 | 改为独立路由页：自适应两栏、右栏复刻 GUI 详情、删除旧对话框 |

## 3. 页面与交互口径

**形态**：`ui.router.register({ name: "fine.search.page", render })`，`navigate({ type: "plugin", name })`
打开。路由页占满主内容区（160×45 实测 root=160×45），无宿主输入框/Sidebar 干扰；随终端 `resize` 实时重排。

**布局**（`pageLayout(width, height)`，纯函数）：

- 宽屏 `width >= 96`：左栏 `max(32, min(64, round(width*0.36)))`，1 列分隔线，右栏吃掉剩余宽度；
- 窄屏 `< 96`：单栏，`Tab` 在「列表 → 摘要 → 回放」循环；
- 高度预算：`bodyHeight = height - 4`（标题/查询/状态/底栏），左栏行数 `bodyHeight - 2`（上下边框），右栏按内容行数裁切。

按键由**页面组件自身创建的 keymap 层**接管（`mode: "global"`、`priority: 1000`），组件销毁即撤销：

| 键 | 摘要视图 | 回放视图 |
| --- | --- | --- |
| `↑` / `↓`（或 `Ctrl+P/N`） | 上一条 / 下一条命中 | 上滚 / 下滚一行 |
| `PgUp` / `PgDn` | 命中跳 10 条 | 加载更早 / 加载更后 |
| `Tab` | 切到只读回放（窄屏：切到回放） | 切回摘要（窄屏：切回列表） |
| `Ctrl+J` | — | 用 `read` 取命中条全文替换 |
| `Ctrl+T` | 思考显隐（两视图共用） | 同左 |
| `Ctrl+O` | 筛选循环：全部 / 回答 / 工具 / 思考 / 提问 | 同左 |
| `Ctrl+U` | 清空查询 | 同左 |
| `Enter` | 命中会话在**后台标签**打开，搜索页保持不动 | 同左 |
| `Esc` | 返回进入搜索页之前的页面（home / 原会话） | 同左 |

**右栏复刻 GUI 详情侧栏**：`全文检索 · 详情 + 第 x / 共 N 条` → 项目/时间/类型 → 会话标题 →
`[类型] [tool] [查询：…]` → `── 当时在做 ──` / `── 解决 ──` / 来源 → `── 原文 ──`（命中词着色）。
`Tab` 切到回放后同一区域显示：标题 + `已载 x–y / 共 N` + 回放行（命中条 `◀ 命中`、思考收起提示）。

**状态保持**：离开页面时把 `query / filter / segmentId / view / showReasoning` 存进模块级
`snapshot`；再次 `/fs` 无参数时恢复查询、筛选、视图与尽量恢复原命中（结果集变化导致该片段不在前
100 条时回退第一条）。

**返回目标**：开标签页时宿主把会话放在标签里，`router.current()` 仍报 `home`；因此打开时优先取
`tabs.list()` 中 `active` 的会话 id，否则用 `router.current()`，随路由 `data.back` 传给页面。

## 4. 常量与布局

模型层（与 GUI 同源）：`DEBOUNCE_MS=120`、`SEARCH_LIMIT=100`、`PREVIEW_LINES=20`、
`PREVIEW_WIDTH=70`、`STREAM_PAGE=40`（服务端上限 80）、`PAGE_HITS=10`。

TUI 层只有两处页面预算，全部由实测宽高换算，不写死列宽：

| 项 | 规则 |
| --- | --- |
| `PAGE_CHROME` | 4（标题 / 查询 / 状态 / 底栏各 1 行） |
| `RIGHT_CHROME` | 10（详情头 1 + 元信息 3 + 摘要基准 4 + 分区 1 + 底部 1） |
| 左栏 | `width*0.36` 夹在 `[32, 64]` |
| 右栏正文 | `right - 2`（缩进 1 + 余量 1） |

## 5. 踩过的坑（勿回退）

1. **富文本别用 `StyledText` + `<text content>`**：类型能过，运行时渲染成 `[object Object]`。
   正确做法是 `<text wrapMode="none" truncate>` 里放 `<span>`；`fg` 未进 `SpanProps` 类型，用展开绕过。
2. **`<For>` 行内不能存布尔快照**：`const isSelected = ... sel()` 只会算一次，选中态不刷新。
   改为先构造行数组（读信号）再渲染，或把信号读取放进 JSX。
3. **长行必须 `wrapMode="none" truncate"`**：否则宿主按自己的宽度算法二次换行，
   会把下一行挤上去，出现「两行字符交错」的鬼影（CJK/全角标点越多越明显）。
4. **列容器里不要堆可变数量的兄弟节点**：右栏改成「先算成 `ScreenRow[]` → 每行一个 `height=1` 的
   `<text>`」，总行数裁到 `bodyHeight`，避免 Yoga 在超高时把相邻行压到同一行。
5. **`fitText` 按字符数截断，CJK 会溢出**：40 个汉字的显示宽度是 80 格。统一用 `clipDisplay`（按 `displayWidth`）。
6. **切换命中必须复位 `busy`**：在途分页请求会被 `tokenLane` 丢弃，`finally` 不再执行，
   `streamBusy` 必须手动清零，否则永久卡「加载中」。
7. **`before` 分页按页宽回退**：`nextOffset(offset, STREAM_PAGE, "before")`；
   `after` 按已载条数推进：`nextOffset(offset, items.length, "after")`（与 GUI `stream-model` 一致）。
8. **加载更早后视口补偿**：`firstLineIndexFor(replayRowsMemo(), topSegmentId)` 定位原顶部片段，
   再 `setReplayScroll`，否则整屏跳动。
9. **导入后缀**：`tui.tsx` / `tui-page.tsx` 用 `./xxx.js`（Bun 加载器约定）；
   `tui-model.ts` 的内部跨文件导入用 `./xxx.ts`，否则 `node --test` 的类型剥离链断掉。
10. **索引缺失不得静默**：`status.ready` 为 false 时列表区显式提示，而不是返回空结果。
11. **共享后台服务会缓存插件特性**：长时间运行的服务里 `/api/plugin` 报
    `features={server,rpc,gui}`（缺 `tui`），TUI 根本不加载本插件。`opencode reload` 可让服务重新扫描
    （2026-11-05 实测：reload 后 `features` 含 `tui`，`/fs` 立即出现），不必重启服务。
12. **路由页才是完整窗口**：对话框受 `xlarge=116` 宽度与高度限制；路由页 root 就是整屏，
    `width/height="100%"` 与百分比/`flexGrow` 都生效，可直接做响应式两栏。

## 6. 自动化验证（真实输出见提交说明）

```
pnpm typecheck   → tsc --noEmit，exit 0
pnpm lint        → oxlint plugin lib tests bin，exit 0（无输出即无告警）
pnpm test        → tests 84 / pass 84 / fail 0
pnpm build:gui   → dist/gui-experimental.cjs 54.08 kB
```

界面用 tmux 伪终端 + `opencode --standalone` 实跑过：

- 160×45：`/fs 连接池` 带参预填、两栏、`↓` 切换且右栏跟随、`Tab` 回放（`已载 …` / `◀ 命中`）、
  `PgUp` 加载更早、`Ctrl+T` 展开思考、`Ctrl+O` 筛选、`Enter` 后台标签打开且页面不动、`Esc` 回原页；
- 100×30 / 80×24：实时 resize 后自动单栏，`Tab` 在列表/摘要/回放之间循环，无换行鬼影；
- 会话内打开：`Esc` 回到原会话；home 打开：`Esc` 回 home。

## 7. 人工验收清单（真终端复核）

1. 裸跑 `opencode` → 按 `<leader>f`（默认 `ctrl+x` 再 `f`；或 `/finesearch`、`/fs`，或命令面板）→ 进入整屏页面，右上显示「N 会话 · N 消息 · N 片段」。
2. `/fs 连接池` → 查询框预填并立即出结果；左栏按会话分组，超长行以 `…` 截断。
3. 右栏与 GUI 详情一致：项目/时间/类型、会话标题、`[类型]` 与查询词、当时在做/解决/来源、原文命中高亮。
4. `↑↓`（或 `Ctrl+P/N`）移动、`PgUp/PgDn` 十条一跳，左栏窗口跟随，无重叠鬼影。
5. `Ctrl+O` 循环筛选，状态行显示当前档位；`Ctrl+U` 清空查询。
6. `Tab` 切回放：显示 `已载 x–y / 共 N`、命中条 `◀ 命中`；`PgUp/PgDn` 分页，视口不跳。
7. `Ctrl+T` 思考展开/收起；`Ctrl+J` 命中条换全文。
8. `Enter`：命中会话在后台标签打开，**搜索页保持**；`Ctrl+Tab` 可切过去。
9. `Esc`：从 home 进入的回 home，从会话进入的回原会话。
10. 拖动终端窗口（160→100→80）：两栏自动变单栏，再拉宽恢复；全程无换行/裁切错位。
11. 删除旁路索引库后重开 → 状态行与列表区显式报「索引未就绪」，不得显示为「没有命中」。