# 详情面板 + 摘要回填 · 实施方案

> 状态：待执行
> 前置分支：`feat/p0-skeleton`
> 示意：`docs/mock/detail-panel.jpg`（源文件 `docs/mock/detail-panel.html`）

## 1. 目标

在现有“原生会话搜索结果”之上，补一个**自动打开的详情面板**，让用户一眼看懂：

1. 这条命中属于**哪个项目**（大项目）
2. 当时**在做什么**（会话任务）
3. 最终**解决了什么**（结果）
4. 命中的**原文**（可折叠、可翻页、可复制）

同时补一个**离线 LLM 批量回填**脚本，给历史会话生成“在做什么 / 解决了什么”，并标注来源。

## 2. 已确认的产品决策

| # | 决策 |
| --- | --- |
| 1 | 保留当前 GUI（包装 `session.list` 追加正文命中），不改成自建搜索框 |
| 2 | 选中结果后 **自动打开** 详情面板（5 秒内有效） |
| 3 | 面板视觉沿用 `docs/mock/detail-panel.jpg`，暗色、紧凑、`ctx.ui` 原生风格 |
| 4 | 面板宽度自适应：`clamp(360px, 31vw, 470px)` |
| 5 | 上下文固定三段：`大项目` / `当时在做` / `解决` |
| 6 | 摘要**必须标注来源**：`记忆` / `自动` / `LLM` |
| 7 | 原文默认显示 **20 行**，超出折叠，按钮“展开全部（共 N 行）” |
| 8 | 摘要优先级：`LLM` > `记忆` > `自动`（自动永远可用，保证 100% 覆盖） |
| 9 | 允许一次性 LLM 批量回填历史；默认只补没有记忆的会话，可 `--force` 全量 |
| 10 | 运行时依旧零依赖、查询期零 LLM |

## 3. 现状（执行前先读）

- 索引：`~/.local/share/opencode-oc-search/index.db`，表 `session / message / segment / segment_fts / meta`，schema_version = 1
- 检索：`lib/index-db.mjs`（FTS5 trigram + LIKE 兜底 + BM25/RRF）
- 同步：`plugin/worker.mjs`（消息指纹增量）
- RPC：`plugin/rpc.ts`（`search` / `read` / `status`）
- GUI：`plugin/gui.tsx` + `plugin/palette-search.ts`（包装 `client.session.list`）
- 测试：`tests/*.test.mjs`，当前 17/17 通过
- opencode-mem：`127.0.0.1:4747`，token 在 `~/.opencode-mem/.auth-token`，摘要字段 `metadata.sessionID`
- 生成接口：`POST /api/experimental/generate/text`，body `{ prompt, model? }`，返回 `{ data: { text } }`
- 服务凭据：`~/.local/state/opencode/service.json`（`url` / `password`，600 权限，**不得打印**）

## 4. 数据模型

`lib/index-db.mjs` 增加（schema_version 1 → 2，仅新增表，不迁移旧数据）：

```sql
CREATE TABLE IF NOT EXISTS summary (
  session_id  TEXT PRIMARY KEY,
  source      TEXT NOT NULL,       -- llm | memory | auto
  project     TEXT NOT NULL,
  doing       TEXT NOT NULL,       -- 当时在做
  solved      TEXT NOT NULL,       -- 解决了什么
  model       TEXT,                -- 仅 llm 记录
  source_hash TEXT,                -- 幂等用
  updated_at  INTEGER NOT NULL
);
```

初始化时若 `schema_version < 2`：建表 + 更新版本，不重建索引。

## 5. 摘要三级来源

### 5.1 自动（`auto`，100% 覆盖，零 LLM）

新增 `lib/summary.mjs`：

| 字段 | 来源 |
| --- | --- |
| `project` | `session.directory` 的 basename |
| `doing` | 会话标题；为空时取首条 `user` 片段前 80 字 |
| `solved` | 最后一条 `assistant` 正文的最后 2 句（≤ 100 字）；没有正文时用最后一条工具名 + “执行完成” |

“大项目”行的附加信息（会话数、最近活跃）由索引实时聚合，不落库。

### 5.2 记忆（`memory`，当前 10/43）

- server 侧 `GET /api/memories?pageSize=100&page=N`（带 token），缓存 10 分钟；
- 建立 `Map<sessionID, content>`（字段 `metadata.sessionID`）；
- 从 `## Outcome` 段取前 2 句，≤ 120 字；
- 连接失败 / 401 / 无 token：静默跳过，不影响面板打开。

### 5.3 LLM（`llm`，离线批量）

由脚本写入，见第 7 节。

### 5.4 读取优先级

```
if summary.source === "llm"     -> 用它
else if memory 命中              -> 用 memory
else                             -> 用 auto
```

面板必须显示来源徽标：

| source | 徽标 |
| --- | --- |
| `llm` | `LLM` |
| `memory` | `记忆` |
| `auto` | `自动` |

## 6. RPC 改动（`plugin/rpc.ts`）

新增方法：

```ts
summary: {
  input:  { sessionId: string }
  output: {
    source: "llm" | "memory" | "auto"
    project: string
    doing: string
    solved: string
    sessionCount: number
    lastActive: number
  }
}
```

- 后端：先查 `summary` 表 → 否则查记忆缓存 → 否则用 `lib/summary.mjs` 计算并写回 `summary`（source=auto）。
- `read(segmentId)` 保持不变；面板自行按 `\n` 计算总行数。
- 失败返回 `index_error`，由面板显示错误态，不静默。

## 7. LLM 批量回填

### 7.1 脚本

`scripts/backfill-summary.mjs`（Node，零依赖）：

```
node scripts/backfill-summary.mjs [--force] [--model provider/model] [--limit N] [--dry-run]
```

流程：

1. 只读索引库，列出会话；
2. 默认跳过已有 `memory` 或 `llm` 摘要的会话；`--force` 全量重做；
3. 组装输入：项目名、会话标题、首条用户消息（≤1500 字）、最后一条助手正文（≤2500 字）、工具名列表；
4. 调用 `POST {url}/api/experimental/generate/text`（`url`/`password` 读 `service.json`，仅内存使用，不打印）；
5. 严格校验返回 JSON；
6. 写入 `summary`（source=`llm`，记录 model 与 `source_hash`）；
7. 顺序执行，间隔 500ms，失败重试 2 次（2s / 5s），单次超时 120s；
8. 结束打印：成功 / 跳过 / 失败数量与耗时。

### 7.2 Prompt 模板

```
你是会话归档器。根据下面的信息，用中文写两句话，只输出 JSON：
{"doing":"...","solved":"..."}

要求：
- doing ≤ 40 字：当时在做什么
- solved ≤ 50 字：最终解决了什么
- 只依据给定内容，不推测、不评价
- 不使用 Markdown，不使用引号以外的标点包裹

项目：{project}
会话标题：{title}
首条用户消息：{firstUser}
最后一条助手回复：{lastAssistant}
使用过的工具：{tools}
```

校验：

- 必须能 `JSON.parse`；
- 两个字段非空、≤ 120 字；
- 失败重试一次，仍失败则保留 `auto` 摘要并在 `meta.last_error` 记录。

### 7.3 幂等与成本

- `source_hash = sha256(firstUser + lastAssistant + model + PROMPT_VERSION)`；
- 相同 hash 跳过；
- 预计 33 个会话（跳过有记忆的），输入约 3–6k 字/个，输出 ~50 token/个；
- 全部失败不影响索引与搜索。

## 8. 详情面板（GUI）

### 8.1 组件与挂载

新增 `plugin/panel.tsx`：

```ts
ctx.add(Panel, {
  id: "detail",
  region: "side",
  list: () => [detailTab],
  render: (props) => <DetailPanel session={props.session} tab={props.tab} />,
})
```

- 面板 key：`${ctx.id}:detail`；
- 打开：`ctx.layout.open(`${ctx.id}:detail`, session, { tab: "select" })`。

### 8.2 布局（严格按示意）

```
头部    全文检索 · 详情      第 n / 共 m      ✕
项目    [■ project]                    时间
标题    会话标题（最多 2 行）
徽标    [类型] [工具名] [查询：关键词]
上下文  [来源徽标] 大项目 / 当时在做 / 解决
原文    命中段（默认 20 行，超出折叠）
导航    片段 n / m        ↑ 上一条  ↓ 下一条
底部    [打开会话] [复制原文]          Esc 关闭
```

响应式：

- 面板宽 `clamp(360px, 31vw, 470px)`；
- 上下文块 `max-height: 34%`，超出内部滚动；
- 原文区 `flex: 1`，最小 120px，超出滚动；
- 标题 `-webkit-line-clamp: 2`；
- 底部按钮固定，不随内容滚动。

### 8.3 折叠规则

- `lines = text.split("\n").length`；
- `lines <= 20`：全量显示；
- `lines > 20`：显示前 20 行 + 按钮 `展开全部（共 N 行）`；
- 展开后原文区滚动，按钮变为 `收起`；
- 切换上/下一条时重置为折叠状态。

### 8.4 自动打开

- 搜索返回时，GUI 记录 `pending = { sessionId -> { segmentId, hits, at } }`；
- `createEffect` 监听 `ctx.sessions.current()`；
- 条件：当前会话 ID 命中 pending、距选中 ≤ 5s、面板未打开；
- 动作：`ctx.layout.open(key, session, { tab: "select" })`，然后清除 pending；
- 用户手动切换会话不触发。

### 8.5 交互

- `Esc` 关闭面板；
- `↑ / ↓` 切换上一条/下一条命中（面板内）；
- `打开会话`：`ctx.tabs.open({ server: "sidecar", id: sessionID }, { focus: true })`；
- `复制原文`：`ctx.system.copy(text)`；
- 空态 / 加载态 / 错误态三态必须实现。

## 9. 文件清单

```
lib/summary.mjs            确定性摘要 + 记忆摘要解析
lib/index-db.mjs           summary 表、schema v2、CRUD
plugin/rpc.ts              summary 方法
plugin/worker.mjs          摘要读取/缓存、summary RPC 实现
plugin/index.ts            RPC 注册（新增方法）
plugin/panel.tsx           详情面板（新）
plugin/gui.tsx             自动打开监听 + 面板注册
scripts/backfill-summary.mjs  LLM 批量回填（新）
tests/summary.test.mjs     摘要优先级 / 解析 / 折叠
tests/panel.test.mjs       自动打开匹配窗口（可纯函数化）
```

## 10. 提交拆分

按顺序，每个 commit 可独立通过 typecheck/test：

1. `feat(index): 新增摘要表与确定性摘要`
2. `feat(rpc): 暴露 summary 接口与记忆摘要缓存`
3. `feat(gui): 新增详情面板与自动打开`
4. `feat(script): LLM 批量回填历史摘要`
5. `test(summary): 覆盖摘要优先级、折叠与自动打开`

不自动 push。

## 11. 验收

1. `pnpm typecheck` 通过；`pnpm test` 全绿（新增用例）。
2. 搜索 `连接池` → 选中结果 → 面板 500ms 内自动打开。
3. 面板显示：项目、会话标题、三个徽标、来源徽标、三段上下文、原文。
4. 原文 > 20 行时折叠；点击展开可滚动；切换命中后回到折叠。
5. `打开会话` 跳到真实会话；`复制原文` 内容与面板一致。
6. 无记忆的会话也有摘要，来源显示 `自动`。
7. 执行 `--dry-run` 回填，输出会话数与预计调用数；实跑后 source 变为 `LLM`。
8. 断开 opencode-mem 时，面板仍可用（来源退化为 `自动`）。

## 12. 风险

| 风险 | 缓解 |
| --- | --- |
| 记忆 API 私有、依赖 4747 | 失败静默降级；token 只在 server 读 |
| LLM 回填有额度成本 | 默认跳过已有摘要；`--dry-run` 先看量；`--limit` 可控 |
| 自动打开误触发 | 5 秒窗口 + 仅搜索命中 + 一次性清除 |
| 面板 API 为 experimental | 锁定 OpenCode 2.2.5；面板层薄，逻辑在 lib |
| 原文行数计算与渲染不一致 | 统一按 `\n` 计数，测试覆盖 |
| 会话标题 + 首条消息可能重复 | 标题为空时才用首条消息 |

## 13. 非目标

- 不改原生搜索列表的宽度/行高（CSS 方案已放弃）
- 不做 TUI 面板（后续）
- 不在查询期调用 LLM
- 不把摘要写回 opencode-mem 数据库