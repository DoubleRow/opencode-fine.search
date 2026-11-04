# opencode-fine.search

把 OpenCode 本地会话库变成**可在 app 内检索的资产**：对 agent 记录过的所有文字做精确 / 模糊检索，点击结果直接定位到原文。

> 现状：P0 插件骨架已完成（server RPC + sidecar 建库 + GUI 标题栏入口）；搜索弹窗与原文面板在 P1/P2。

## 为什么

OpenCode V2 自带的搜索只覆盖**会话标题**；会话正文、工具输出、思考过程都躺在
`~/.local/share/opencode/opencode.db` 里，但没有任何入口可以检索。

本项目做三件事：

1. 建一份**旁路全文索引**（只读源库，不改 OpenCode 数据）。
2. 在 OpenCode Desktop 里提供搜索框与原文定位面板。
3. 保留 CLI，供脚本与验收使用。

## 设计原则

| 原则 | 说明 |
| --- | --- |
| 精确优先 | FTS5 字面子串命中；BM25 只负责排序 |
| 零 LLM | 建库、查询、排序全程不调用模型 |
| 本地闭环 | 不联网；语义 lane 仅访问 `127.0.0.1:4747` |
| 只读源库 | `opencode.db` 以 `readOnly` 打开 |
| 可删可重建 | 索引是派生数据，损坏就重建 |
| 不伪装 | 索引缺失/降级必须显式提示 |

## 索引范围

覆盖全部历史会话（含子会话、挂起会话），入库字段：

- 用户提问、助手正文、思考过程（默认隐藏）
- 工具输入 / 工具输出
- 系统注入、合成消息、压缩摘要

排除：

- `data:` URI（图片/附件 base64，本机实测 324 MB）
- `write` 的文件正文、`edit` 的 old/new 字符串
- 快照 diff、模型元数据

## 检索分层

| 层 | 手段 | 目标延迟 |
| --- | --- | --- |
| L0 精确 | FTS5 trigram（≥3 字符）/ `LIKE`（1–2 字符） | < 15 ms |
| L1 排序 | BM25 + 段/会话 RRF(k=60) | < 20 ms |
| L2 语义 | opencode-mem `/api/search`，并行追加 | 30–750 ms |

## 目录

```
bin/oc-search          CLI 启动器（sh）
bin/oc-search.mjs      CLI 实现
lib/                   抽取 / 索引 / 同步 / 检索核心
plugin/                OpenCode 插件（server + GUI，后续加 TUI）
plugin/worker.mjs      Node sidecar（node:sqlite）
tests/                 node --test
```

旁路索引：`~/.local/share/opencode-oc-search/index.db`（600，可删除）。

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

环境变量：`OPENCODE_DB` 覆盖数据库路径（默认 `~/.local/share/opencode/opencode.db`）。

## 插件（Desktop）

P0 插件由 server 部分（`plugin/index.ts`）与 GUI 部分（`plugin/gui.tsx` → `plugin/dist/gui-experimental.cjs`）组成。
server 通过 RPC 暴露 `search` / `read` / `status`，实际建库与检索由 Node sidecar（`plugin/worker.mjs`）完成。

```bash
pnpm build:gui                                  # 生成 GUI bundle
node plugin/worker.mjs status                   # 查看索引状态
node plugin/worker.mjs sync                     # 建库/增量同步
node plugin/worker.mjs search 连接池 --limit 3   # 命令行验证同一套检索
```

把插件目录加入全局 `opencode.json` 的 `plugins` 后才在 Desktop 中加载：

```jsonc
{
  "plugins": ["/home/row/文档/opencode项目/opencode-fine.search/plugin"]
}
```

之后在 **Settings > Extensions > Plugins** 可见；标题栏图标与 `mod+shift+g` 命令会先探测索引状态。
临时覆盖：`OC_SEARCH_INDEX` 指定索引文件，`OC_SEARCH_NODE` 指定 node 绝对路径，`OC_SEARCH_VERBOSE=1` 输出同步进度。

## 开发

前置：Node ≥ 22.5（使用内置 `node:sqlite`）、pnpm。

```bash
pnpm install          # 仅安装开发依赖（打包 / 类型）
pnpm typecheck
pnpm test
pnpm build:gui        # 构建 GUI 插件（CJS）
pnpm dev:gui          # 监听重建
```

运行时依赖为 0；`devDependencies` 用于 Vite 打包与 `@opencode/plugin` 类型。

## 路线

| 阶段 | 内容 |
| --- | --- |
| P0 | 插件骨架：server 注册 + GUI 标题栏入口 + sidecar 建库 |
| P1 | 搜索弹窗：分级检索、结果分组、高亮 |
| P2 | 原文定位：跳会话 + 面板渲染命中窗口 |
| P3 | 语义 lane：opencode-mem 只读接入 + 降级 |
| P4 | TUI 移植：复用同一 RPC |

## 已知限制

- 原文可能已被 OpenCode 截断（本机 68 处），索引无法恢复。
- `opencode.db` 中 V1 旧表（`message` / `part`）仅 4 / 10 行，未纳入。
- GUI 插件 API 仍为 experimental，升级 OpenCode 后需要回归。

## 许可

[MIT](./LICENSE)