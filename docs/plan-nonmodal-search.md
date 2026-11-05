# 非模态搜索浮层 · 实施方案（C 路线）

> 状态：待执行
> 取代：`docs/plan-detail-panel.md` 中「自动打开详情面板」的交互部分
> 沿用：摘要来源、三段上下文、20 行折叠、来源徽标

## 1. 背景

当前 Cmd/Ctrl+Shift+F 打开的是 OpenCode 原生 `DialogSessionSearch`：

- 全屏 scrim 压黑主界面，侧边栏不可见；
- 上下键/悬停只切换列表高亮，原生没有预览逻辑；
- 会话结果只是标题 + 项目名 + 时间，无法展开原文；
- 官方没有注入点，继续打补丁会越来越脆。

因此改为**自建非模态搜索浮层**：不遮主界面、不抢模态焦点、选中即预览、回车才打开会话。

## 2. 查证结论（源码依据）

### 2.1 搜索图标可以放在「会话名 + ⋯」之后

`app/src/session/timeline/message-timeline.tsx` 的头部结构：

```tsx
<SessionTitleHeader>
  <SessionHeaderLayout
    location={...}
    title={...}
    actions={(fit) => (
      <>
        {props.search}                 {/* Ctrl+F 的会话内搜索条，默认隐藏 */}
        <PluginSlot at="session.header" input={{ session, screen, active, compact }} />
        <SessionHeaderSpacer ... />
      </>
    )}
  >
    <h1>会话标题</h1>
    <Menu>⋯（outline-dots）</Menu>   {/* 在 title 区域，位于 actions 之前 */}
  </SessionHeaderLayout>
</SessionTitleHeader>
```

DOM 顺序：

```
.session-header-location   （项目 / worktree）
.session-header-title      （h1 标题 + ⋯ 菜单）
.session-header-actions    （Ctrl+F 搜索条 → 插件 slot → spacer）
```

- `session.header` slot **天然位于 ⋯ 之后**，不需要 CSS 调序；
- 样式：`.session-header-actions { display:flex; gap:8px; margin-inline-start:6px }`，与原生图标间距一致；
- 只有 Ctrl+F 的内联搜索条展开时，它才会排在插件图标前面；需要固定顺序时给插件元素加 `order:-1`。

### 2.2 左侧边栏不可控

GUI 可注入的位置只有：

```
window.bottom / session.header / session.location.menu / session.panel.end
```

没有 `sidebar`。所以「上下键同步左侧会话列表」**做不到**；本方案把「同步」落在**浮层内的预览区**。

### 2.3 为什么用 `window.bottom` 挂浮层

- slot 常驻挂载，首页与会话页都存在；
- 子元素用 `position: fixed` 脱离布局，不会占底部高度；
- 不依赖当前会话，跨会话搜索时不会因切会话而消失；
- 没有 Dialog 的 scrim，不会压黑主界面。

> P0 需先验证：`window.bottom` 的祖先没有 `transform/filter`，否则 fixed 会被限制为局部定位。

## 3. 目标交互

```
┌ 会话标题区 ─────────────────────────────────────────────┐
│ 项目 / worktree   会话标题  ⋯   [🔍]                    │ ← 插件图标在 ⋯ 后
├─────────────────────────────────────────────────────────┤
│                                                         │
│   主界面（时间线）保持可见，不变暗、不模糊                │
│                                                         │
│        ┌ 搜索全部会话 ────────────────────────────┐      │
│        │ > 连接池                            Esc   │      │
│        │ [全部] [回答] [工具] [思考] [提问]          │      │
│        ├──────────────────────────────────────────┤      │
│        │ 今天 · opencode-fine.search               │      │
│        │ 08:08 工具输出  OpenCode 搜索 P0 骨架      │      │
│        │        …max_connections 被打满…            │      │
│        │ 05:33 回答      方案调研与工程初始化        │      │
│        ├──────────────────────────────────────────┤      │
│        │ 预览                                      │      │
│        │ 大项目  opencode-fine.search · 43 会话     │      │
│        │ 当时在做 …                                │      │
│        │ 解决    …                                │      │
│        │ 原文（20 行，可展开）                      │      │
│        └──────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────┘
```

规则：

| 操作 | 行为 |
| --- | --- |
| 点击标题行 🔍 / `⌘⇧G` | 打开/关闭浮层，输入框自动聚焦 |
| 输入 | 100ms 防抖，调用现有 `search` RPC |
| `↑` / `↓` / 鼠标悬停 | 切换当前结果，**预览区即时更新**（不切会话） |
| `Enter` | 打开该结果所属会话（`ctx.tabs.open`），关闭浮层 |
| `Esc` | 关闭浮层，焦点回到时间线 |
| 点击浮层外 | 关闭（透明遮罩，不变暗） |
| 切换筛选 | 重新查询，保持输入 |

浮层外遮罩：透明、`pointer-events:auto`，只负责“点外面关闭”；**不改变主界面亮度**。

## 4. 组件结构

```
plugin/overlay.tsx      浮层（搜索框 + 结果 + 预览 + 键盘）
plugin/header-entry.tsx 会话标题行图标（Slot session.header）
plugin/gui.tsx          注册 Slot / Command / 快捷键
plugin/rpc.ts           search / read / summary（沿用/补充）
```

- 浮层挂载：`ctx.add(Slot, { at: "window.bottom", render: () => <SearchOverlay /> })`
- 显隐状态：模块级 signal，`window.bottom` slot 常驻但浮层默认 `display:none`
- 图标：`ctx.add(Slot, { at: "session.header", order: 0, render: () => <HeaderSearchButton /> })`
- 命令：`ctx.add(Command, { id: "search", bind: "mod+shift+g" })`
- 首页没有会话标题行：靠命令/快捷键打开；如需图标，再加 `TitlebarItem`

## 5. 数据与 RPC

沿用现有：

- `search({ query, limit, includeReasoning, includeTools })`
- `read({ segmentId })`
- 新增 `summary({ sessionId })`（来源 / 项目 / 当时在做 / 解决）

预览区逻辑：

1. 结果列表返回后，选中第一条，调用 `read` + `summary`；
2. 上下键/悬停只改 `activeIndex`，用 120ms 防抖请求预览；
3. 旧请求用序号丢弃，避免闪烁；
4. 预览失败显示错误态，不阻塞列表。

摘要优先级沿用：`LLM > 记忆 > 自动`；来源徽标 `LLM` / `记忆` / `自动`。

## 6. 视觉规格

- 浮层宽度：`min(720px, calc(100vw - 96px))`；
- 位置：水平居中，顶部距离标题栏约 64px；
- 背景：`var(--v2-background-bg-layer-01)`，边框 `var(--v2-border-border-base)`，圆角 8px；
- 结果行：两行（标题 + 摘要），选中态使用 `var(--v2-overlay-simple-overlay-hover)`；
- 预览区：与列表之间 1px 分隔线；摘要块最高 34%，原文区 `flex:1` 滚动；
- 原文默认 20 行，超出折叠；展开后滚动；
- 全部使用 `ctx.ui` 组件与主题变量，不写死颜色。

## 7. 实施顺序

1. **P0 验证**（半天）
   - `window.bottom` 挂 `position:fixed` 浮层是否正常覆盖；
   - `session.header` 图标位置与间距；
   - 快捷键在输入框内不冒泡到时间线。
2. **P1 浮层骨架**（1 天）
   - Slot 挂载、显隐、透明遮罩、Esc/点击外部关闭；
   - 搜索框 + 结果列表 + 空/加载/错误三态。
3. **P2 预览联动**（1 天）
   - ↑↓/悬停 → `read` + `summary`；
   - 三段上下文、来源徽标、20 行折叠。
4. **P3 打开会话**（0.5 天）
   - `ctx.tabs.open({ server:"sidecar", id })`；
   - 关闭浮层；必要时在目标会话打开详情面板（可选）。
5. **P4 收尾**（0.5 天）
   - 首页命令入口、快捷键提示、README 更新。

## 8. 验收

1. `⌘⇧G` 或标题行 🔍 打开浮层，主界面**不变暗**、侧边栏可见。
2. 输入关键词，结果 300ms 内出现（本地索引毫秒级）。
3. `↑↓` / 悬停时，预览区同步切换项目、标题、摘要、原文。
4. `Enter` 打开真实会话；`Esc` 关闭；点浮层外关闭。
5. 无记忆的会话显示 `自动` 摘要；opencode-mem 断开时浮层仍可用。
6. 原文 > 20 行可展开/收起；切换结果重置折叠。
7. `pnpm typecheck`、`pnpm test` 全绿。

## 9. 风险

| 风险 | 缓解 |
| --- | --- |
| fixed 被祖先 transform 限制 | P0 先验证；失败则退回 `ctx.layout.open` 侧栏面板 |
| z-index 冲突（toast/dialog） | 浮层 z-index 40，dialog 50；toast 更高 |
| 输入框抢时间线快捷键 | `onKeyDown` 阻止冒泡；Esc 显式处理 |
| 透明遮罩挡住主界面点击 | 明确“搜索时主界面不可点”；如需要，后续加非阻塞模式 |
| 首页无 header 图标 | 命令/快捷键兜底；可选 TitlebarItem |

## 10. 明确不做

- 不改左侧边栏内容（无 API）；
- 不恢复原生 `DialogSessionSearch` 的 scrim；
- 不在浮层里做向量检索（语义 lane 后置）；
- 不自动打开详情面板（预览已在浮层内，避免二次弹层）。