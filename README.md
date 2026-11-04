# OPskill

把 OpenCode 本地会话库变成可检索资产的工具集。第一个工具是 `oc-search`。

## 为什么

OpenCode V2 没有会话全文搜索：CLI 只有 `list/delete/export/import`，TUI 没有 search 键位，HTTP API 也没有检索端点。
但所有会话都躺在 `~/.local/share/opencode/opencode.db` 里，可以直接只读查询。

## oc-search

只读打开 SQLite，在 `session_message.data` 的 JSON 里做关键词匹配，输出带上下文的片段。

```bash
./bin/oc-search 向量化
./bin/oc-search 向量化 webui --any --limit 5
./bin/oc-search embedding --since 2026-10-20
./bin/oc-search 随机森林 --dir 考研
./bin/oc-search --list
```

### 选项

| 选项 | 说明 |
|---|---|
| `--any` | 多个关键词取「或」，默认「且」 |
| `--limit <n>` | 最多输出条数，默认 20 |
| `--session <id>` | 限定会话 ID（前缀匹配） |
| `--dir <path>` | 限定会话目录（子串匹配） |
| `--type user\|assistant` | 限定消息类型 |
| `--since <YYYY-MM-DD>` | 只看该日期之后 |
| `--include-reasoning` | 也搜思考过程（默认跳过，噪声大） |
| `--no-tools` | 不搜工具调用内容 |
| `--json` | 输出 JSON，便于二次处理 |
| `--list` | 列出全部会话 |
| `--no-color` | 关闭高亮 |

### 环境变量

- `OPENCODE_DB`：覆盖数据库路径，默认 `~/.local/share/opencode/opencode.db`。

## 前置条件

- Node.js >= 22.5（使用内置 `node:sqlite`）。本机 Node 24.21 实测可用，无需 `--experimental-sqlite`。
- 无需安装任何 npm 依赖。

## 设计红线

- **只读**：`new DatabaseSync(path, { readOnly: true })`，绝不写库、不做迁移、不建索引。
- **不出机**：不联网，不上传任何会话内容。
- **不改 OpenCode 配置**：工具独立运行，装不装进 `opencode.json` 由使用者决定。

## 已知限制

- 关键词是字面子串匹配，不是语义检索；想按意思搜请用 `opencode-mem` 的向量能力。
- 全表扫描，`session_message` 当前约 5k 行、DB 约 400 MB，单次查询在秒级以内。
- 只覆盖 V2 的 `session_message` 表；更早的 V1 数据在 `message` / `part` 表，未纳入。

## 目录

```
bin/oc-search      启动器（sh）
bin/oc-search.mjs  实现
```