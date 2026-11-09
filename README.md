# opencode-fine.search

把 OpenCode 本地会话库变成**可检索的资产**：正文、工具输出、思考过程都能搜；
不切页面，在当前会话里就能看另一个会话的全文。

[![更好的opencode搜索演示封面](docs/media/opencode-search-cover.png)](https://www.bilibili.com/video/BV1pd4t6XErW/)

▶ **[观看 42 秒演示（B 站）](https://www.bilibili.com/video/BV1pd4t6XErW/)** ·
[下载演示片](docs/media/opencode-search-demo.mp4)（3.8 MB）

> 演示数据取 2026-11-05 本机快照（48 会话 / 7,573 消息 / 14,703 片段），命中文案为示例。

## 视频里演示了什么

多开几个会话后，结论散在各处：想引用另一个会话的结果，只能切过去、复制、再切回来。
这个插件把「搜索 → 预览 → 回放 → 带走 → 贴回」压进当前会话：

| 动作 | 行为 |
| --- | --- |
| 搜索 | `👓 全文` / `Ctrl+Shift+G`，非模态浮层，主界面不变暗 |
| 预览 | `↑↓` 看摘要与命中原文，只切换选中项，不切会话 |
| 回放 | `Enter` 打开整段只读流水，命中处有锚点 |
| 带走 | 框选原文，`Ctrl+C` |
| 贴回 | `Esc` 收起浮层，草稿和上下文原样保留，`Ctrl+V` 贴回输入框 |
| 终端 | `/fs` 两栏检索页，`Enter` 后台开标签，搜索页不动 |

## 两个入口

| 入口 | 形态 | 适合 |
| --- | --- | --- |
| **GUI（Desktop）** | 非模态搜索浮层 + 右侧详情栏 | 桌面端日常使用，主界面不中断 |
| **TUI（终端）** | 占满主内容区的两栏路由页 | 纯终端环境，键盘流操作 |

> 现状：GUI（P1）与 TUI（P2）均已落地，自动化门禁 84 项测试全绿。
> 语义检索（向量 lane）**尚未实现**，当前只有精确 / 模糊检索；视频片尾也做了标注。

## 特性

- **跨会话全文**：用户提问、助手正文、思考过程、工具输入 / 输出；排除 base64 附件与文件正文。
- **精确优先**：FTS5 trigram（≥3 字符）+ 1–2 字符 `LIKE` 兜底，BM25 只负责排序。
- **本地闭环**：旁路索引，只读源库，查询期零模型调用；索引可删可重建。
- **只读回放**：命中会话整段分页加载，不写回源库。
- **GUI / TUI 共用一套 RPC**：`search` / `read` / `summary` / `stream` / `status`。
- **CLI 保留**：脚本与验收可直接调用 `./bin/oc-search`。

## 设计原则

| 原则 | 说明 |
| --- | --- |
| 精确优先 | FTS5 字面子串命中；BM25 只负责排序 |
| 零 LLM | 建库、查询、排序全程不调用模型 |
| 只读源库 | `opencode.db` 以 `readOnly` 打开 |
| 本地闭环 | 不联网；记忆摘要只读本机 `127.0.0.1:4747` |
| 可删可重建 | 索引是派生数据，损坏就重建 |
| 不伪装 | 索引缺失/降级必须显式提示，不返回「看似成功的空结果」 |

---

## 安装

前置：Node ≥ 22.5（使用内置 `node:sqlite`）、pnpm、OpenCode ≥ 2.2.5（开发与构建的类型依赖已对齐 2.2.6）。

```bash
pnpm install      # 只有开发依赖；运行时依赖为 0
pnpm build:gui    # 构建 Desktop 插件产物 plugin/dist/gui-experimental.cjs
```

把插件目录加入 OpenCode 全局配置：

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-fine.search/plugin"]
}
```

同一个目录同时提供两个导出：

- `./gui-experimental` → Desktop GUI（需先 `pnpm build:gui`）
- `./tui` → 终端 TUI（源码直载，无需构建）

Desktop 改完源码后会自动重载；也可在 **Settings > Extensions > Plugins** 手动 Reload。

---

## GUI（Desktop）

### 入口

- 会话标题行右侧的 **`👓 全文`** 按钮（位于原生图标簇最左）
- 命令面板：**全文检索：搜索全部会话**（`Ctrl/Cmd+Shift+G`）

### 交互

| 操作 | 行为 |
| --- | --- |
| 打开浮层 | 主界面不变暗、侧边栏保持可见，输入框自动聚焦 |
| 输入 | 防抖后调用本地索引，结果按会话分组 |
| `↑` / `↓` / 悬停 | 只切换选中项，**右侧详情栏即时预览**，不切会话 |
| `Enter` | 在标签页打开命中会话，关闭浮层 |
| `Esc` / 点击浮层外 | 关闭浮层 |
| 浮层宽度 | 随右侧详情栏是否展开自动避让 |

### 详情栏

- 项目 / 时间 / 命中类型
- 会话标题与 `[类型]` `[tool]` `[查询：…]` 标记
- **当时在做** / **解决** 两段摘要，来源徽标 `LLM` / `记忆` / `自动`（优先级 `LLM > 记忆 > 自动`）
- 命中原文默认 20 行，可展开；可切换为整段会话的只读回放（分页加载）

> 说明：默认**不再包装原生 `Ctrl+Shift+F` 会话搜索**（`USE_NATIVE_SEARCH_PATCH = false`），
> 避免与自建浮层重复入口。

---

## TUI（终端）

### 入口

三条通道等价：

- 键位 **`<leader>f`**（默认 `Ctrl+X` 再按 `f`）
- 命令面板：**全文检索（历史会话）**
- 斜杠命令 **`/finesearch`**（别名 `/fs`，支持 `/fs 关键词` 预填查询）

### 形态

- 占满主内容区的路由页，不再是固定宽度对话框；
- 宽 ≥ 96 列：左栏结果、右栏详情（复刻 GUI 侧栏）；
- 窄屏：单栏，`Tab` 在「列表 → 摘要 → 回放」之间循环；
- 随终端 resize 实时重排。

### 按键

| 键 | 摘要视图 | 回放视图 |
| --- | --- | --- |
| `↑` / `↓`（或 `Ctrl+P/N`） | 上一条 / 下一条命中 | 上滚 / 下滚一行 |
| `PgUp` / `PgDn` | 跳 10 条命中 | 加载更早 / 加载更后 |
| `Tab` | 切到只读回放 | 切回摘要 |
| `Ctrl+J` | — | 用 `read` 取命中条全文 |
| `Ctrl+T` | 思考显隐 | 思考显隐 |
| `Ctrl+O`（兼容 `Ctrl+0`） | 筛选循环：全部 / 回答 / 工具 / 思考 / 提问 | 同左 |
| `Ctrl+U` | 清空查询 | 清空查询 |
| `Enter` | 命中会话在**后台标签**打开，搜索页保持 | 同左 |
| `Esc` | 返回进入搜索页之前的页面（home / 原会话） | 同左 |

> 宿主限制：插件页不能单独占一个标签，只能占用当前标签的路由；
> 因此 TUI 搜索页会暂时接管当前标签，`Esc` 返回原页面。

---

## 索引与检索

### 索引范围

覆盖全部历史会话（含子会话、挂起会话），入库字段：

- 用户提问、助手正文、思考过程（默认隐藏，可开关）
- 工具输入 / 工具输出
- 系统注入、合成消息、压缩摘要

排除：

- `data:` URI（图片/附件 base64，本机实测约 324 MB）
- `write` 的文件正文、`edit` 的 old/new 字符串
- 快照 diff、模型元数据

旁路索引：`~/.local/share/opencode-oc-search/index.db`（权限 600，可删除重建）。
按消息指纹增量同步，不写源库。

### 检索分层

| 层 | 手段 | 状态 |
| --- | --- | --- |
| L0 精确 | FTS5 trigram（≥3 字符）；1–2 字符走 `LIKE` 兜底 | 已实现 |
| L1 排序 | BM25 + 段/会话 RRF(k=60) | 已实现 |
| L2 语义 | `opencode-mem` 向量检索 | **未实现**（仅摘要读取） |

### RPC

`search` / `read` / `summary` / `stream` / `status`，由 server 插件注册、
Node sidecar（`plugin/worker.mjs`）执行。GUI 与 TUI 复用同一套接口。

---

## CLI

```bash
./bin/oc-search 连接池
./bin/oc-search 向量化 webui --any --limit 5
./bin/oc-search embedding --since 2026-10-20
./bin/oc-search 随机森林 --dir 考研
./bin/oc-search --list
```

| 选项 | 说明 |
| --- | --- |
| `--any` | 多个关键词取「或」，默认「且」 |
| `--limit <n>` | 最多输出条数，默认 20 |
| `--session <id>` | 限定会话 ID（前缀匹配） |
| `--dir <path>` | 限定会话目录（子串匹配） |
| `--type user\|assistant` | 限定消息类型 |
| `--since <YYYY-MM-DD>` | 只看该日期之后 |
| `--include-reasoning` | 也搜思考过程 |
| `--no-tools` | 不搜工具调用内容 |
| `--json` | 输出 JSON |
| `--list` | 列出全部会话 |
| `--no-color` | 关闭高亮 |

sidecar 子命令：`status` / `sync` / `search` / `read` / `summary` / `stream` / `serve`。

```bash
node plugin/worker.mjs status
node plugin/worker.mjs sync
node plugin/worker.mjs search 连接池 --limit 3
```

环境变量：

| 变量 | 作用 |
| --- | --- |
| `OPENCODE_DB` | 覆盖源库路径 |
| `OC_SEARCH_INDEX` | 覆盖索引路径 |
| `OC_SEARCH_NODE` | 指定 node 绝对路径 |
| `OC_SEARCH_MEMORY_URL` | opencode-mem 地址（默认 `http://127.0.0.1:4747`） |
| `OC_SEARCH_VERBOSE=1` | 输出同步进度 |

---

## 目录

```
bin/oc-search          CLI 启动器（sh）
bin/oc-search.mjs      CLI 实现
lib/                   抽取 / 索引 / 同步 / 检索 / 摘要核心
plugin/index.ts        server 插件：RPC 注册
plugin/gui.tsx         GUI 入口：浮层、详情栏、命令
plugin/tui.tsx         TUI 入口：路由页、键位、斜杠命令
plugin/tui-page.tsx    TUI 路由页
plugin/worker.mjs      Node sidecar（node:sqlite）
tests/                 node --test
docs/                  方案、交接与实现记录
```

---

## 开发

```bash
pnpm lint         # oxlint（0 告警基线）
pnpm typecheck    # tsc --noEmit（覆盖 plugin 的 ts/tsx）
pnpm test         # node --test，84 项
pnpm build:gui    # 构建 GUI 插件（CJS）
pnpm dev:gui      # 监听重建
```

运行时依赖为 0；`devDependencies` 只用于打包、类型与 lint。

---

## 已知限制

- 语义检索（向量 lane）未实现，不要按「已支持语义」使用。
- 原文可能已被 OpenCode 截断，索引无法恢复。
- `opencode.db` 中 V1 旧表数据量极少（本机 `message` 4 行），未纳入索引。
- GUI / TUI 插件 API 仍为 experimental，升级 OpenCode 后需要回归。
- 左侧会话列表无法由插件写入，因此不做「搜索时同步高亮侧栏」。

## 变更记录

见 [CHANGELOG.md](./CHANGELOG.md)。

## 许可

[MIT](./LICENSE)