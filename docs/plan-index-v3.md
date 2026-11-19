# 索引架构 v3 · P0：三级变更检测 + 双模式写入

> 状态：已实现（schema v3）。本文件记录三张闸门的职责、双模式阈值与理由、DDL、性能预算，
> 以及实测数字与取舍。检索逻辑（BM25 / RRF / 片段截取 / `mode` 语义）在本次改动中**未动**。

## 1. 问题：变更检测太重，同步卡在查询链路上

改动前的同步每次都把 `session_message` 全表读一遍（含 `length(data)`）：

| 操作 | 改动前实测 |
| --- | --- |
| 每次同步的指纹扫描（约 9,900 行、含 `length(data)`） | **330–432 ms**（实际扫了数百 MB 正文） |
| 增量同步 221 条消息 | 10.3 s（≈47 ms/条） |
| 全量重建 18,800+ 段 | 18.0 s（tmpfs）/ 55.8 s（机械盘，见 §5） |

源库索引状况（实查）：`session_message` 有 `(session_id, seq)`、`(session_id, type, seq)`、
`(session_id, time_created, id)` 三个索引；`seq` 在会话内唯一且随 `time_created` 单调递增。
按会话聚合 `count / max(seq) / max(time_updated)` 只需 **13 ms**，且不读正文。

## 2. 三张闸门

```
L0 指纹门   源库主文件 + WAL 的 (size, mtime) 四元组
            ├─ 与内存缓存或 meta.source_sig 相同 → 直接返回 { skipped: true }
            └─ 一次重查询都不发
L1 会话门   SELECT session_id, count(*), max(seq), max(time_updated)
            FROM session_message GROUP BY session_id          （实测 13 ms）
            ├─ 与 session 表的 (msg_count, seq_max, last_msg_updated) 比对
            └─ 只保留发生变化的会话
L2 消息门   只对 L1 判定变化的会话：
            SELECT id, session_id, type, seq, time_created, time_updated, length(data)
            FROM session_message WHERE session_id = ?
            ├─ 与 message 表 (seq, time_updated, type, data_length) 比对
            └─ 不读 data
L3 读正文   仅对 L2 判定变化的 id 执行 SELECT data → extractSegments → 替换片段
```

删除处理：

- **会话级**：源库 `session_v2` 的 id 集合与索引 `session` 表求差集 —— 这部分本来就小，全量比对；
- **消息级**：只对 L1 判定变化的会话比对 id 集合，不做全库比对。

`source_sig` 只在**成功提交之后**才写入；失败时保留旧值，下一次同步会重试。

## 3. 双模式写入

阈值常量 `REBUILD_THRESHOLD = 2000`，可用环境变量 `OC_SEARCH_REBUILD_THRESHOLD` 覆盖（测试用）。

| 条件 | 模式 |
| --- | --- |
| 索引文件不存在 / 段数为 0 | 重建 |
| 刚完成 schema 迁移（`meta.rebuild_pending = 1`） | 重建 |
| 待处理改动（新增 + 更新 + 删除）≥ 阈值 | 重建 |
| 其余 | 就地补丁（每批 `BATCH_SIZE = 500` 条，单事务） |

**为什么「积压超阈值就重建」**：本机实测顺序重建约 1.8 ms/条，就地补丁约 47 ms/条，相差约 25 倍。
补丁路径要为每条消息做一次主键查询、一次删除、若干次插入；重建路径是顺序写入，还能顺手清掉碎片。

重建流程：

1. 写到 `${INDEX_PATH}.new`（同目录，权限 600）；
2. 重建期间该临时库关闭回滚日志与 fsync（`journal_mode=OFF` + `synchronous=OFF`）——
   产物校验不过就整份删掉，半成品不会污染现役索引；
3. 校验 `indexCounts()` 与源库的会话数、消息数一致，不一致即失败；
4. 重建时按 `(message_id, ordinal)` 沿用旧索引的片段 id —— 重建 / 迁移前后 `segmentId` 不变，
   GUI / TUI 里已打开的定位锚点不会失效（新增片段才分配新 id）；
5. 关闭句柄 → 删除旧索引的 `-wal` / `-shm` → `renameSync(.new, INDEX_PATH)` → 重新打开；
6. `meta.gen += 1`；
7. 任一步失败：删掉 `.new`、保留旧索引、错误向上抛；rename 失败时重新打开旧索引继续服务。

失效模式与对策：

| 风险 | 对策 |
| --- | --- |
| 重建途中断电 | `.new` 不完整，启动后仍用旧索引，下次同步重来 |
| rename 时目标被占用（Windows） | 保留旧索引并报错，不删任何文件 |
| 迁移中途失败 | `ALTER` 全部回滚，`schema_version` 留在 2，返回明确迁移错误 |
| 两个进程同时写 | 单写者约定（sidecar 只有一个），不做跨进程锁 |

## 4. schema v3

新增列（`ALTER TABLE ... ADD COLUMN`，原地迁移，不重建表）：

```sql
ALTER TABLE session ADD COLUMN seq_max          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session ADD COLUMN msg_count        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session ADD COLUMN last_msg_updated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE message ADD COLUMN seq              INTEGER NOT NULL DEFAULT 0;
```

- 新建库直接在 `CREATE TABLE` 里带上这些列；
- v1 / v2 库在写打开时补列并把 `schema_version` 置 3，同时置 `rebuild_pending = 1`
  → 下一次同步走重建，把水位值补齐（旧行的水位默认 0，不重建就会被判成「整库都变了」）；
- 只读打开（`status()`）允许 v1 / v2 / v3，所以升级前 GUI / TUI 仍能报告状态；
- 原有 `message.time_updated` / `data_length` 保留，`fingerprintOf` 不再是同步主依据。

## 5. 性能预算与实测

| 场景 | 预算 | 实测 |
| --- | --- | --- |
| L0 空转（进程内第二次及以后，零查询） | < 2 ms | **0 ms** |
| L0 空转（每次新进程，读 meta） | < 2 ms | **1 ms** |
| 小增量（2 条消息） | < 200 ms | **32–86 ms** |
| 小增量（19 条消息） | < 200 ms | **151 ms** |
| 全量重建（tmpfs，`/tmp/opencode`） | ≤ 20 s | **17.4 s** |
| 全量重建（机械盘，现役目录） | ≤ 20 s | **18.7 s** |
| 18,900 段全量重建（改动前同一份数据） | — | tmpfs 18.1 s / 机械盘 55.8 s |
| v2 → v3 迁移 + 重建（同一冻结快照） | ≤ 20 s | **17.1 s**，迁移前后 10 个查询词 JSON 逐字段一致 |

> **关于 18 s 这个基线**：它是在 tmpfs 上测的。现役索引在 `/dev/sda2`（`rotational=1`，机械盘），
> 同一份数据、同一版旧代码在这里要 55.8 s —— 130 MB 的随机写被盘拖住了。
> 重建临时库关掉日志与 fsync 后，机械盘降到 18.7 s，与 tmpfs 基本持平。
> 这也是为什么重建步骤里要专门加那两条 `PRAGMA`。

## 6. 可观测性

`status()` 新增四个字段（全部保留原有字段）：

| 字段 | 含义 |
| --- | --- |
| `gen` | 索引代际，每次重建 +1 |
| `lastSyncMs` | 上次同步耗时（含重建），毫秒 |
| `lastSyncSkipped` | 上次同步是否被 L0 跳过 |
| `sourceSig` | 上次成功同步时的源库指纹（`size:mtime|walSize:walMtime`） |

对应 meta key：`gen`、`last_sync_ms`、`last_sync_skipped`、`source_sig`（外加 `rebuild_pending`）。

## 7. 测试

`tests/sync-v3.test.mjs`（全部用临时目录里的合成源库，不连真实 `opencode.db`）：

1. 空索引首次同步走重建，计数与源库一致；
2. 源库没变时走 L0 跳过，且索引文件 mtime 不变（断言「没有写」）；
3. 新增一条消息只碰该会话，未变会话的片段 id 保持不变；
4. 改已有消息时旧片段被替换、不残留；
5. 删除消息 / 删除会话会同步删除；
6. 积压达到阈值（测试里设 2）改走重建，`gen` 递增，检索结果与增量路径逐字段一致；
7. v2 索引写打开时迁移到 v3，查询结果不变，迁移后 `rebuild_pending` 清零、再同步走 L0。

## 8. 不在本次范围

- 检索逻辑（排序、RRF、BM25、片段截取、`mode` 语义）；
- 分词器与 1–2 字查询（LIKE 全表扫描冷启 4.5 s 的问题留给下一阶段）；
- 向量 / chunk / 语义 lane；
- 事件订阅（`ctx.event.subscribe`，P2）；
- `bin/oc-search` 直读源库那条腿。