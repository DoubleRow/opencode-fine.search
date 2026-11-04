# OPskill — 项目规范

> 优先级：本文件 > `~/.config/opencode/AGENTS.md`（全局）> 模型默认行为。

## 目标

把 OpenCode 本地数据（会话库、配置、插件状态）做成**可检索、可验证**的本地工具集。
第一个产出是 `bin/oc-search`：只读检索 `~/.local/share/opencode/opencode.db`。

## 红线

1. **数据库只读**：一律 `new DatabaseSync(path, { readOnly: true })`。禁止写库、建索引、ALTER、VACUUM、迁移。
   备份 `opencode.db` 不算本项目的职责；如确需，先按全局 §1.1 走知情决策。
2. **不联网**：工具不得向任何外部服务发送会话内容。要做语义检索，用本机已有的
   `127.0.0.1:11435`（llama-server / Qwen3-Embedding 0.6B）。
3. **不新增依赖**：优先 Node 内置模块（`node:sqlite`、`node:fs`）。确需第三方包先问。
4. **不改全局配置**：`~/.config/opencode/opencode.json`、`opencode-mem.jsonc` 只读参考，不在本项目里改。

## 结构

```
bin/oc-search       sh 启动器
bin/oc-search.mjs   实现（ESM，node:sqlite）
```

新增工具沿用同样布局：`bin/<name>` 启动器 + `bin/<name>.mjs` 实现，命令名短、参数自解释。

## 验收

改动后必须跑真实查询并贴输出，不能只说"应该没问题"：

```bash
./bin/oc-search 向量化 --limit 3     # 应命中历史会话
./bin/oc-search --list | head -5     # 应列出 40+ 会话
./bin/oc-search 不存在的词xyz        # 应输出「没有命中」且退出码 1
```

Python 型工具才用 `uv run ruff check .`；当前项目无 Python。

## 代码约定

- 异步/异常不吞：数据库打开失败要给出路径和原因。
- 参数解析拒绝未知选项，返回码 2。
- 输出默认给人看，`--json` 给机器看。
- 中文输出，字段名英文。