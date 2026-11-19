/**
 * 索引 v3 同步：三级闸门 + 双模式写入。
 *
 * 全部用临时目录里的合成源库，绝不连真实 opencode.db。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

const WORKER = fileURLToPath(new URL("../plugin/worker.mjs", import.meta.url));

const SOURCE_DDL = `
CREATE TABLE IF NOT EXISTS session_v2 (
  id TEXT PRIMARY KEY,
  title TEXT,
  directory TEXT NOT NULL,
  parent_id TEXT,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  seq INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
`;

function withEnv(fn, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oc-sync-v3-"));
  const env = {
    ...process.env,
    OPENCODE_DB: join(dir, "source.db"),
    OC_SEARCH_INDEX: join(dir, "index.db"),
    NO_COLOR: "1",
    ...extra,
  };
  try {
    return fn({ dir, env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(env, args) {
  return spawnSync(process.execPath, [WORKER, ...args], { encoding: "utf8", env });
}

function sync(env) {
  const res = run(env, ["sync", "--json"]);
  assert.equal(res.status, 0, `sync 失败: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function status(env) {
  const res = run(env, ["status", "--json"]);
  assert.equal(res.status, 0, `status 失败: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function search(env, query, limit = 10) {
  const res = run(env, ["search", query, "--limit", String(limit), "--json", "--no-color"]);
  // 无命中时 CLI 约定退出码 1，JSON 仍然完整。
  assert.ok(res.status === 0 || res.status === 1, `search 失败: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

/** 打开夹具源库（每次改动都重开，确保 WAL 落盘）。 */
function openSource(env) {
  const db = new DatabaseSync(env.OPENCODE_DB);
  db.exec(SOURCE_DDL);
  return db;
}

function addSession(db, { id, title, directory = "/w/project", parent = null, created = 1000, updated = 1000 }) {
  db.prepare(
    `INSERT INTO session_v2(id, title, directory, parent_id, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, title, directory, parent, created, updated);
}

function userData(text) {
  return JSON.stringify({ text });
}

function assistantData(text) {
  return JSON.stringify({ content: [{ type: "text", text }] });
}

function addMessage(db, { id, sessionId, type = "user", seq, ts = 1000, data }) {
  db.prepare(
    `INSERT INTO session_message(id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sessionId, type, seq, ts, ts, data);
}

/** 两个会话的小型夹具：ses_a 两条消息、ses_b 一条。 */
function seedBasic(env) {
  const db = openSource(env);
  addSession(db, { id: "ses_a", title: "连接池讨论" });
  addSession(db, { id: "ses_b", title: "向量检索", directory: "/w/other" });
  addMessage(db, { id: "msg_1", sessionId: "ses_a", seq: 1, data: userData("连接池会不会漏连接") });
  addMessage(db, {
    id: "msg_2",
    sessionId: "ses_a",
    type: "assistant",
    seq: 2,
    data: assistantData("连接池需要复用与超时"),
  });
  addMessage(db, { id: "msg_3", sessionId: "ses_b", seq: 1, data: userData("向量检索怎么接入") });
  db.close();
}

/** 索引里 (message_id, ordinal) → segment id，用于验证重建后 id 稳定。 */
function readSegmentIds(env) {
  const db = new DatabaseSync(env.OC_SEARCH_INDEX, { readOnly: true });
  const map = new Map();
  for (const row of db.prepare("SELECT id, message_id, ordinal FROM segment").all()) {
    map.set(`${row.message_id}#${row.ordinal}`, Number(row.id));
  }
  db.close();
  return map;
}

/** 只比对检索契约字段：重建会重排 segment id，但排序与片段必须一致。 */
function searchShape(result) {
  return result.items.map((item) => ({
    sessionId: item.sessionId,
    messageId: item.messageId,
    kind: item.kind,
    ts: item.ts,
    title: item.title,
    directory: item.directory,
    snippet: item.snippet,
    matchStart: item.matchStart,
    matchEnd: item.matchEnd,
    score: item.score,
  }));
}

test("空索引首次同步走重建，计数与源库一致", () =>
  withEnv(({ env }) => {
    seedBasic(env);
    const first = sync(env);
    assert.equal(first.mode, "rebuild");
    assert.equal(first.skipped, false);
    assert.equal(first.sessions, 2);
    assert.equal(first.messages, 3);
    assert.equal(first.segments, 3);
    assert.equal(first.gen, 1);

    const state = status(env);
    assert.equal(state.ready, true);
    assert.equal(state.gen, 1);
    assert.equal(state.indexedSegments, 3);
    assert.ok(state.sourceSig.length > 0);
  }));

test("源库没变时走 L0 跳过且不写索引", () =>
  withEnv(({ env }) => {
    seedBasic(env);
    sync(env);
    const indexPath = join(env.OC_SEARCH_INDEX);
    const before = statSync(indexPath).mtimeMs;

    const second = sync(env);
    assert.equal(second.skipped, true);
    assert.equal(second.mode, "skip");
    assert.equal(second.changed, 0);
    assert.ok(second.elapsedMs < 200, `空转应很快，实测 ${second.elapsedMs} ms`);

    const third = sync(env);
    assert.equal(third.skipped, true);
    assert.equal(statSync(indexPath).mtimeMs, before, "空转不应写索引文件");
  }));

test("新增一条消息只碰该会话，已有片段 id 不变", () =>
  withEnv(({ env }) => {
    seedBasic(env);
    sync(env);
    const beforeB = search(env, "向量检索").items[0].segmentId;

    const db = openSource(env);
    addMessage(db, { id: "msg_4", sessionId: "ses_a", seq: 3, ts: 2000, data: userData("新增的连接池排查") });
    db.close();

    const result = sync(env);
    assert.equal(result.mode, "incremental");
    assert.equal(result.added, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.segments, 4);
    assert.equal(result.gen, 1, "增量不换代");

    const hit = search(env, "排查");
    assert.equal(hit.items.length, 1);
    assert.equal(hit.items[0].sessionId, "ses_a");
    assert.equal(search(env, "向量检索").items[0].segmentId, beforeB, "未变会话的片段 id 应保持不变");
  }));

test("改已有消息时旧片段被替换、不残留", () =>
  withEnv(({ env }) => {
    seedBasic(env);
    sync(env);
    assert.ok(search(env, "漏连接").items.length > 0);

    const db = openSource(env);
    db.prepare(
      `UPDATE session_message SET data = ?, time_updated = ? WHERE id = 'msg_1'`,
    ).run(userData("改成完全不同的措辞"), 3000);
    db.close();

    const result = sync(env);
    assert.equal(result.mode, "incremental");
    assert.equal(result.updated, 1);
    assert.equal(result.added, 0);

    assert.equal(search(env, "漏连接").items.length, 0, "旧正文不应残留");
    assert.equal(search(env, "完全不同的措辞").items.length, 1);
  }));

test("删除消息与会话会同步删除索引记录", () =>
  withEnv(({ env }) => {
    seedBasic(env);
    sync(env);

    const db = openSource(env);
    db.prepare("DELETE FROM session_message WHERE id = 'msg_2'").run();
    db.prepare("DELETE FROM session_message WHERE session_id = 'ses_b'").run();
    db.prepare("DELETE FROM session_v2 WHERE id = 'ses_b'").run();
    db.close();

    const result = sync(env);
    assert.equal(result.removedMessages, 1);
    assert.equal(result.removedSessions, 1);
    assert.equal(result.sessions, 1);
    assert.equal(result.messages, 1);
    assert.equal(result.segments, 1);
    assert.equal(search(env, "向量检索").items.length, 0);
  }));

test("积压达到阈值时改走重建，结果与增量一致", () =>
  withEnv(
    ({ dir, env }) => {
      seedBasic(env);
      sync(env);

      const db = openSource(env);
      for (let i = 0; i < 3; i += 1) {
        addMessage(db, {
          id: `msg_bulk_${i}`,
          sessionId: "ses_b",
          seq: 10 + i,
          ts: 5000 + i,
          data: userData(`批量补课第${i}条：批量补课关键词`),
        });
      }
      db.close();

      const idsBefore = readSegmentIds(env);
      const result = sync(env);
      assert.equal(result.mode, "rebuild");
      assert.equal(result.gen, 2, "重建换代 gen +1");
      assert.equal(result.messages, 6);

      // 重建沿用旧片段 id：旧片段一个都不许换号。
      const idsAfter = readSegmentIds(env);
      for (const [key, id] of idsBefore) {
        assert.equal(idsAfter.get(key), id, `重建后 ${key} 的 segmentId 应保持不变`);
      }

      // 同样内容的源库用「大阈值」走增量，比对检索契约字段。
      const plainEnv = {
        ...env,
        OC_SEARCH_INDEX: join(dir, "index-incremental.db"),
        OC_SEARCH_REBUILD_THRESHOLD: "100000",
      };
      sync(plainEnv);
      const rebuilt = searchShape(search(env, "批量补课"));
      const incremental = searchShape(search(plainEnv, "批量补课"));
      assert.deepEqual(rebuilt, incremental);
      assert.equal(rebuilt.length, 3);
    },
    { OC_SEARCH_REBUILD_THRESHOLD: "2" },
  ));

test("v2 索引写打开时迁移到 v3，查询结果不变", () =>
  withEnv(({ env }) => {
    seedBasic(env);
    sync(env);
    const before = searchShape(search(env, "连接池"));
    const beforeRaw = search(env, "连接池");

    // 手工降级成 v2：去掉 v3 的列，版本号退回 2。
    const db = new DatabaseSync(env.OC_SEARCH_INDEX);
    db.exec("ALTER TABLE session DROP COLUMN seq_max");
    db.exec("ALTER TABLE session DROP COLUMN msg_count");
    db.exec("ALTER TABLE session DROP COLUMN last_msg_updated");
    db.exec("ALTER TABLE message DROP COLUMN seq");
    db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
    db.close();

    const beforeUpgrade = status(env);
    assert.equal(beforeUpgrade.ready, true, "v2 索引在只读状态检查里仍可用");

    const result = sync(env);
    assert.equal(result.mode, "rebuild");
    assert.equal(result.gen, 2, "迁移后必定重建一次");

    const after = searchShape(search(env, "连接池"));
    assert.deepEqual(after, before);
    // 迁移同样沿用旧片段 id：整份 JSON（含 segmentId）必须一致。
    assert.deepEqual(search(env, "连接池"), beforeRaw);

    const upgraded = new DatabaseSync(env.OC_SEARCH_INDEX, { readOnly: true });
    const version = upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const pending = upgraded.prepare("SELECT value FROM meta WHERE key = 'rebuild_pending'").get();
    upgraded.close();
    assert.equal(String(version.value), "3");
    assert.equal(String(pending.value), "0");

    // 迁移后列值已补齐，再同步应走 L0 跳过。
    assert.equal(sync(env).skipped, true);
  }));