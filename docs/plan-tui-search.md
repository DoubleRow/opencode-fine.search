# TUI 全文检索（P2）· 实现记录

> 状态：代码完成，自动化门禁全绿；**界面手感待人工验收**（TUI 无法在本环境自证）
> 承接：`docs/handoff-tui.md` §3.4 分阶段计划
> 复用：`SearchRpc`（server 插件）、`overlay-model` / `stream-model` / `panel-model` 纯函数

## 1. 交付物

| 文件 | 作用 |
| --- | --- |
| `plugin/tui.tsx` | TUI 插件入口 + 搜索对话框（表现层与交互状态机） |
| `plugin/tui-model.ts` | 纯逻辑：分组、导航、预览裁窗、回放行、打开会话通路 |
| `plugin/package.json` | 新增 `"./tui"` 导出与 `@opentui/*`、`solid-js` 对等依赖声明 |
| `tests/tui-model.test.mjs` | 纯函数单测（79 项全套件的一部分） |

入口三通道：命令面板「全文检索（历史会话）」、斜杠 `/finesearch`（别名 `/fs`）、键位 `<leader>f`。
`<leader>f` 与 `ctrl+o` 按官方 `docs/cli/keybinds`（2026-11-05 实查）确认未被默认占用。

## 2. 分阶段提交

| 阶段 | 提交 | 内容 |
| --- | --- | --- |
| S1 | `785f1f1` | `./tui` 导出 + 入口 + 对话框骨架 + status/search |
| S2 | `80c69b2` | 结果列表分组、键盘导航、筛选三态 |
| S3 | `955fba5` | 预览列：会话摘要 + 20 行命中原文 + 词高亮 |
| S4 | `e3df66e` | 只读回放分页、思考收起、Ctrl+J 展开全文 |
| S5 | 本次 | Enter 打开会话、空态/错误态/未就绪态收尾、本文档 |

## 3. 交互口径（与 GUI 对齐）

对话框内按键由**对话框组件自身创建的 keymap 层**接管（`mode: "global"`、`priority: 50`），
组件销毁即撤销，不会污染宿主按键。未绑定任何可打印键，输入仍归 `<input>`。

| 键 | 预览视图 | 回放视图 |
| --- | --- | --- |
| `↑` / `↓` | 上一条 / 下一条命中 | 上滚 / 下滚一行 |
| `PgUp` / `PgDn` | 命中跳 10 条 | 加载更早 / 加载更后 |
| `Tab` | 切到只读回放 | 切回预览 |
| `Ctrl+J` | — | 用 `read` 取命中条全文替换 |
| `Ctrl+T` | 思考显隐（两视图共用） | 同左 |
| `Ctrl+O` | 筛选循环：全部 / 用户 / 助手 / 思考 / 工具 | 同左 |
| `Enter` | 打开会话并关闭对话框 | 同左 |
| `Esc` | 关闭对话框 | 同左 |

打开会话通路（`openPlan`，有单测）：`tabs.enabled()` 为真先 `tabs.focus(sessionId)`，
返回 false 或抛错则回退 `router.navigate({ type: "session", sessionID })`；两者都失败写入错误行。

## 4. 常量

模型层（与 GUI 同源）：`DEBOUNCE_MS=120`、`SEARCH_LIMIT=100`、`PREVIEW_LINES=20`、
`PREVIEW_WIDTH=70`、`STREAM_PAGE=40`（服务端上限 80）、`PAGE_HITS=10`。

TUI 层（只影响终端观感，改这些不动检索逻辑）：

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `DIALOG_WIDTH` | 112 | `xlarge` 实测 116 列，留 4 列内边距 |
| `LEFT_WIDTH` | 42 | 左栏（结果列表） |
| `RIGHT_WIDTH` | 68 | 右栏（预览 / 回放） |
| `TEXT_WIDTH` | 64 | 右栏正文实际换行宽度 |
| `LIST_WINDOW` | 10 | 左栏可见行数 |
| `TUI_PREVIEW_LINES` | 8 | 预览实际渲染行数（`PREVIEW_LINES=20` 保留给模型口径） |
| `REPLAY_WINDOW` | 24 | 回放可见行数 |

45 行终端下这些值刚好放下输入框、两栏与底栏按键提示；终端更矮时优先减 `TUI_PREVIEW_LINES`。

## 5. 踩过的坑（勿回退）

1. **富文本别用 `StyledText` + `<text content>`**：类型能过，运行时渲染成 `[object Object]`
   （本机 opencode 2.2.5 内嵌的 OpenTUI 与本地 0.8.2 类型不同源）。
   正确做法是 `<text>` 里放 `<span>`；`fg` 未进 `SpanProps` 类型，用展开绕过本地类型。
2. **`<For>` 行内不能存布尔快照**：`const isSelected = ... sel()` 只会算一次，选中态不刷新。
   必须在 JSX 属性/子节点里内联读信号（实测：方向键改了 `sel()`，`❯` 不跟着走）。
3. **百分比宽度不生效**：`width="40%"` / `width="100%"` 都被忽略（内容缩成 ~60 列）。
   用数值宽度 + `DIALOG_WIDTH/LEFT_WIDTH/RIGHT_WIDTH`。
4. **`fitText` 按字符数截断，CJK 会溢出**：40 个汉字的显示宽度是 80 格，行会二次换行。
   列表行必须用 `clipDisplay`（按 `displayWidth` 计，CJK 记 2 格）。
5. **切换命中必须复位 `busy`**：在途分页请求会被 `tokenLane` 丢弃，`finally` 不再执行，
   `streamBusy` 必须手动清零，否则永久卡「加载中」。
6. **`before` 分页按页宽回退**：`nextOffset(offset, STREAM_PAGE, "before")`；
   `after` 按已载条数推进：`nextOffset(offset, items.length, "after")`（与 GUI `stream-model` 一致）。
7. **加载更早后视口补偿**：`firstLineIndexFor(replayRowsMemo(), topSegmentId)` 定位原顶部片段，
   再 `setReplayScroll`，否则整屏跳动。
8. **导入后缀**：`tui.tsx` 用 `./xxx.js`（Bun 加载器约定，同 `index.ts`）；
   `tui-model.ts` 的内部跨文件导入用 `./xxx.ts`，否则 `node --test` 的类型剥离链断掉。
9. **索引缺失不得静默**：`status.ready` 为 false 时列表区显式提示，而不是返回空结果。
10. **共享后台服务会缓存插件特性**：长时间运行的服务里 `/api/plugin` 报
    `features={server,rpc,gui}`（缺 `tui`），于是 TUI 根本不加载本插件，
    `/fs` 与会话内按键全部消失；同样的包在 `opencode --standalone`（私有服务）下
    `features` 含 `tui`，插件正常加载。改完 `exports["./tui"]` 后必须让共享服务重新扫描
    （重启服务或重连），只重启 TUI 进程不够。

## 6. 自动化验证（真实输出见提交说明）

```
pnpm typecheck   → tsc --noEmit，exit 0
pnpm lint        → oxlint plugin lib tests bin，exit 0（无输出即无告警）
pnpm test        → tests 80 / pass 80 / fail 0
```

`pnpm build:gui` 亦需通过（GUI 不回归）。

界面部分用 tmux 分配伪终端 + `opencode --standalone` 实跑过（160×45）：
`/fs` 出现并打开对话框、检索出结果、`↓` 切换命中且右侧预览跟随、`Tab` 进回放、
`PgDn` 加载更后、`Ctrl+T` 展开思考、`Enter` 打开会话、`Esc` 只关对话框，均已观察通过。

## 7. 人工验收清单（真终端复核）

1. 裸跑 `opencode` → 按 `<leader>f`（默认 `ctrl+x` 再 `f`；或输 `/finesearch`、`/fs`，或命令面板选「全文检索」）→ 弹出对话框，状态行显示「索引就绪 · N 会话 / …」。
2. 输入跨会话关键词（如 `连接池`）→ 左侧按会话分组列出命中（每行单行截断、选中行带 `❯`），右侧同步预览摘要 + 前 8 行原文，命中词着色。
3. 输入 2 字词（如 `向量`）→ 仍命中（LIKE 兜底）；输入随机串（如 `zzqqxvbnm1234`）→ 显示「没有命中」。
4. `↑↓` 逐条移动、`PgUp/PgDn` 十条一跳，列表窗口随之滚动不裁切。
5. `Ctrl+O` 循环筛选，底栏括号内显示当前档位。
6. `Tab` 进回放 → 顶栏显示「只读回放 · 会话标题 · 已载 x–y / 共 N」；`PgDn` 加载更后、`PgUp` 加载更早，视口不跳动。
7. `Ctrl+T` 思考段在「已收起提示」与全文之间切换；`Ctrl+J` 命中条换成全文，提示行消失。
8. `Enter` 打开命中所在会话（开标签页模式时聚焦标签，否则整页跳转），对话框关闭。
9. `Esc` 只关对话框，再次打开是干净状态。
10. 删除旁路索引库后重开 → 状态行与列表区显式报「索引未就绪」，不得显示为「没有命中」。
