# Ctrl+F 会话内查找接口 · 复用可行性研究

> 结论先行：**不能"接管"原生 Ctrl+F，但可以在同一位置重建一个等效、且完全可控的入口。**
> 原生 Ctrl+F 是一个**内联小输入条**（非模态），形态正确；但它的检索逻辑写在会话屏内部、没有插件接口、没有插槽、栏宽 200px 放不下结果列表。
> 真正要解决的问题不是"复用这个控件"，而是**把结果从"遮住侧栏的对话框"搬到"不遮侧栏的常驻区域"**。
> 依据：本机 OpenCode Desktop 2.2.5 的 `app.asar` 源码映射（`app/src/...`，下文行号为映射内原始行号），与 `@opencode/plugin@2.2.5` 的 GUI 类型定义。

## 1. 三个已核实的事实

### 1.1 现在用的「会话搜索」是模态对话框，必然遮住侧栏

- `app/src/shell/titlebar/titlebar.tsx`：命令 `sessions.search`，`keybind: "mod+shift+f"`，`onSelect` → `dialog.show(() => <DialogSessionSearch />)`。
- `app/src/shell/commands/session-search.tsx:85`：内容就是 `CommandPaletteView`。
- `ui/src/context/dialog.tsx`：每个 dialog 走 `Kobalte.Portal` + `Kobalte.Overlay`，图层容器 `position: fixed; inset: 0; z-index: …`。

**推论**：对话框一张开就是全窗口覆盖层，侧栏在它下面；而且 `app/src/shell/commands/command.tsx` 的 `handleKeyDown` 开头是 `if (suspended() || dialog.active) return`——**对话框打开期间插件快捷键全部失效**。所以"搜索时侧栏联动"在当前入口上不是调样式能解决的，是结构冲突。

### 1.2 Ctrl+F 是会话头部的内联输入条，不遮侧栏，但只搜当前会话

- `app/src/session/timeline/search-controller.ts:225-236`：注册隐藏命令 `session.search`，`keybind: "mod+f"`；同时监听 `document` 事件 `opencode:timeline-search-open` 来打开。
- `app/src/session/timeline/search-bar.tsx:12`：容器 `h-7 w-[200px] max-w-[50vw]`；输入框是 `<input data-slot="text-input-v2-input">`，`onInput` 直接写控制器状态。
- `search-controller.ts:117-165`：命中来源是 `data.session.message.list(sessionID)`，**只遍历当前会话已加载的消息**，只取 `type === "text"` 的可见正文。
- `search-controller.ts:28-100`：高亮用 CSS Custom Highlight API（`CSS.highlights`），滚动用 `range.getBoundingClientRect()` + `scrollTo`。

**推论**：它是"当前会话内查找"，不是检索入口——不跨会话、不搜工具输出/思考、没有结果列表（只有 `n/m` 计数 + Enter/↑↓ 前进后退）。栏宽 200px 也装不下结果。

### 1.3 插件侧真正能落地的位置（官方 API，非 DOM 注入）

| 能力 | 定义 | 用途 |
| --- | --- | --- |
| `Slot at="session.header"` | `plugin/dist/gui/registries.d.ts` SlotMap | **和 Ctrl+F 同一行**：`message-timeline.tsx` 里 `props.search` 与 `PluginSlot at="session.header"` 都渲染在 header 的 `actions` 区 |
| `Slot at="window.bottom"` | 同上 | 窗口底部全宽条（`shell.tsx` 中 `<PluginSlot at="window.bottom" />` 位于 main 与 Toast 之间），适合放结果列表 |
| `Panel region:"side"` | `registries.d.ts:246-254` | 右侧栏标签页，`layout.open(key, session)` 可对未挂载会话打开 |
| `Command.bind` | `registries.d.ts:32` | 插件命令可绑 `mod+f`（与原生同名键位的优先级见 §4.3，需实测） |
| `ctx.keybinds.matches(id, event)` | `host-apis.d.ts:1118` | 读取"某命令当前生效键位是否匹配此事件"，可用于跟随用户自定义 |
| `ctx.tabs.open` / `layout.side.toggle` | `host-apis.d.ts` | 打开会话、控制侧栏开关 |

**没有**的：主区域自定义路由/页面（Registry 只有 Command / MenuItem / Panel / SettingsPage / Server / LinkHandler / TitlebarItem / ComposerPill / Slot / Style）；没有"时间线内高亮并定位到某条消息"的公开方法（`Panel` 能拿到 `session`，但拿不到滚动定位 API）。所以"点结果跳会话"只能做到**打开会话**，正文高亮只能在**侧栏里自己渲染原文**——这也正是现有 `DetailPanel` 的做法，方向是对的。

## 2. 逐项可行性打分（针对"复用 Ctrl+F"这个具体问法）

| 能力 | 判定 | 依据 |
| --- | --- | --- |
| 用代码打开 Ctrl+F 条 | ✅ 可行 | `document.dispatchEvent(new Event("opencode:timeline-search-open"))`，控制器在 `document` 上监听（`search-controller.ts:234`）；插件 bundle 在渲染进程同一 window 内求值（`app/src/runtime/plugin/module.ts`），`document` 可达 |
| 读它的输入内容 | ✅ 可行 | `document.querySelector('[data-component="timeline-search-bar"] input')`，监听 `input` 事件 |
| 阻止它自己跑本地检索 | ⚠️ 勉强可行 | 只能在捕获阶段 `stopPropagation()` 掉 Solid 的 `onInput`；控件是受控输入（`value={c.query.value()}`），状态一旦变化可能把用户输入回写；无任何 API 保证 |
| 让它显示跨会话结果列表 | ❌ 不可行 | 栏宽 200px；组件内没有列表结构；`matches` 数据源写死当前会话 |
| 复用它的高亮/滚动去定位命中 | ❌ 不可行 | `collectRanges`/`scrollToMatch` 是闭包内私有函数，仅按"当前会话 + 查询串"工作，不接受外部命中 |
| 升级后稳定 | ❌ 不可行 | 全靠 DOM 类名与事件名，任一版本改结构即失效 |

**结论**：字符串意义上"复用 Ctrl+F 的接口"只有入口与输入框两层可用，价值低、脆弱性高；**它的形态（非模态、常驻、Esc 关闭、Enter 循环）才是应该复制的资产**，而这些用 `Slot` 自建反而是官方支持的路径。

## 3. 三个方案（按推荐度）

### 方案 A（推荐）：头部输入条 + 底部结果条 + 右侧详情

```
┌───────────────────────────────────────────────┬────────────┐
│ 会话标题        [🔍 输入…]  ← session.header 插槽 │  详情面板   │
├───────────────────────────────────────────────┤  原文/摘要  │
│                                               │  （side）   │
│  会话正文                                     │            │
├───────────────────────────────────────────────┤            │
│ 结果条：项目 · 会话 · 片段 · 命中词  ← window.bottom │         │
└───────────────────────────────────────────────┴────────────┘
```

- 输入：`ctx.add(Slot, { at: "session.header", render: … })`，样式对齐现有 `text-input-v2`，外观与 Ctrl+F 一致。
- 结果：`Slot at="window.bottom"`，横向列表或紧凑表格，键盘 ↑↓ + 鼠标悬停。
- 联动：`hover / ↑↓` 只更新共享 signal（不切会话），`DetailPanel` 立即渲染该片段的项目、会话、原文；`click` 才 `ctx.tabs.open()` 打开会话。
- 唤起：插件 `Command` 绑 `mod+f`（见 §4.3）；同时保留点击输入框聚焦的路径。
- 成本：中（新增 1 个结果条组件 + 把现有 `palette-search` 的查询逻辑接过来，复用 `DetailPanel` 与 `panel-model`）。
- 风险：`window.bottom` 的实际高度/遮挡需要真机看一眼；输入条与原生 Ctrl+F 条并排时的排布需要调。

### 方案 B（最省）：侧栏内三段式（输入 + 结果 + 原文）

- 全部塞进现有 `Panel region:"side"`：顶部输入、中部结果列表、下部原文。
- 零位置冲突、零 DOM 依赖，改 `panel.tsx` 即可；缺点是"结果"和"详情"从左到右变成从上到下，且侧栏本来就不宽。
- 成本：小；可作为 A 的第一步（先把搜索从 dialog 搬出来，再优化布局）。

### 方案 C（原型级，不建议交付）：劫持 Ctrl+F 输入框

```ts
// 仅验证用
document.dispatchEvent(new Event("opencode:timeline-search-open"))
const bar = document.querySelector('[data-component="timeline-search-bar"]')
bar?.addEventListener("input", (e) => { /* 读 (e.target as HTMLInputElement).value → 查 FTS */ }, true)
```

- 能跑通"输入 → 结果（渲染在别处）"，但原生控制器同时也在跑：会在当前会话里跳来跳去、`n/m` 计数错乱、Esc 关闭后状态残留。
- 结论：**只用来验证 30 分钟内能否看到效果，不作为交付路径。**

## 4. 关键不确定项（需 10 分钟级 spike 验证）

### 4.1 `window.bottom` 的实际布局

底部条会不会挤压会话区、是否与 Composer/Toast 重叠。验证：临时 `ctx.add(Slot, { at: "window.bottom", render: () => <div style={{height:"120px", background:"red"}} /> })`，看截图。

### 4.2 侧栏在"打开别的会话"后是否还能保持我们的详情

`layout.open(key, session)` 是**按会话**的，切会话后标签仍在（`PanelProps.session` 是响应式 getter）。验证：在详情面板开着的情况下 `tabs.open` 另一个会话，观察详情是否跟随/消失。

### 4.3 `mod+f` 谁先注册（决定能否直接用 Ctrl+F 唤起）

- 机制：`commandKeymap` 按注册顺序入队同一键位，`resolveKeybindOption` 取第一个未声明 `when` 的候选（`app/src/shell/commands/command.tsx:151-181`）；用户自定义键位排在最前。
- 原生 `session.search` 由**会话屏创建时**注册（`createTimelineSearchController`），插件在**应用启动时**注册 → 插件更早，理论上插件抢占 `mod+f`。
- 验证：插件加一个 `bind: "mod+f"` 的命令，`run` 里 `console.log`；在会话页按 Ctrl+F，看是否插件日志出现、原生条是否弹出。
- 若失败：改用 `mod+shift+f` 之外的键（如 `mod+shift+g`），或读 `ctx.keybinds.matches("session.search", event)` 后自行捕获——**不建议**在没有实测前就把原生 Ctrl+F 屏蔽。

### 4.4 原文片段能否支撑"侧栏即详情"

索引里 `segment.text` 是否有足够上下文（现有 `DetailPanel` 已按行折叠，20 行）。验证：拿 3 条真实命中看首屏信息是否够判断。

## 5. 建议的落地顺序

1. **今日**：spike 4.1 + 4.3（各 30 分钟内），确认"底部条可用、Ctrl+F 可抢"。
2. **P1.5**：把 `palette-search` 的检索从"包装 `session.list`"抽成独立的 `search(query)` 调用（现在它已经依赖 sidecar，改动很小）。
3. **P2**：按方案 A 实现输入条 + 结果条；`DetailPanel` 原样复用，只把数据源从 `pending` 改成"当前 hover/选中项"。
4. **回退路径**：若 4.1 布局不可接受 → 降级为方案 B（全部放侧栏），仍然满足"搜索时不遮侧栏、选中即联动"的核心诉求。

## 6. 明确不做

- 不接管/改写原生 Ctrl+F 的实现（不可维护）。
- 不为了"复用"去改 OpenCode 安装包（`/opt/OpenCode`，root 所有，且每次升级失效）。
- 不在对话框上做样式补丁（遮罩是 portal + fixed inset-0，改不动且脆弱）。

## 7. 一句话给决策

**"复用 Ctrl+F"这个想法对了一半：要复用的是它的"非模态、常驻、贴着会话"的形态，不是它的代码。** 官方给的两个插槽（`session.header`、`window.bottom`）+ 现有详情面板，足以做出"输入 → 结果 → 侧栏联动"的完整体验，且不碰任何私有实现。
