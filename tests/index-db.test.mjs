import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  indexStatus,
  openIndex,
  readSegment,
  replaceIndexMessage,
  searchSegments,
  setMeta,
  upsertSession,
} from "../lib/index-db.mjs";

function withIndex(fn) {
  const dir = mkdtempSync(join(tmpdir(), "oc-search-test-"));
  const path = join(dir, "index.db");
  const db = openIndex(path);
  try {
    return fn(db, path);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seed(db) {
  upsertSession(db, {
    id: "ses_a",
    title: "连接池讨论",
    directory: "/home/row/project",
    time_created: 1_700_000_000_000,
    time_updated: 1_700_000_000_000,
  });
  upsertSession(db, {
    id: "ses_b",
    title: "向量检索",
    directory: "/home/row/other",
    time_created: 1_700_000_100_000,
    time_updated: 1_700_000_100_000,
  });

  replaceIndexMessage(
    db,
    {
      id: "msg_1",
      sessionId: "ses_a",
      type: "assistant",
      timeCreated: 1_700_000_000_000,
      timeUpdated: 1_700_000_000_000,
      dataLength: 100,
    },
    [
      { kind: "assistant", text: "连接池的实现要考虑复用与超时" },
      { kind: "reasoning", text: "连接池内部状态需要思考" },
      { kind: "tool", text: "rg 连接池 lib" },
    ],
  );

  replaceIndexMessage(
    db,
    {
      id: "msg_2",
      sessionId: "ses_b",
      type: "user",
      timeCreated: 1_700_000_100_000,
      timeUpdated: 1_700_000_100_000,
      dataLength: 80,
    },
    [{ kind: "user", text: "向量化检索怎么接入" }],
  );
}

test("≥3 字符走 FTS5，reasoning 默认隐藏", () =>
  withIndex((db) => {
    seed(db);
    const result = searchSegments(db, "连接池");
    assert.equal(result.mode, "fts");
    assert.equal(result.query, "连接池");
    assert.ok(result.items.length >= 1);
    assert.ok(result.items.every((item) => item.kind !== "reasoning"));
    assert.ok(result.items[0].snippet.includes("连接池"));

    const withReasoning = searchSegments(db, "连接池", { includeReasoning: true });
    assert.ok(withReasoning.items.some((item) => item.kind === "reasoning"));
  }));

test("1–2 字符走 LIKE 兜底", () =>
  withIndex((db) => {
    seed(db);
    const result = searchSegments(db, "向量");
    assert.equal(result.mode, "like");
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].sessionId, "ses_b");
  }));

test("无命中返回空数组而不是报错", () =>
  withIndex((db) => {
    seed(db);
    const result = searchSegments(db, "不存在的词xyz");
    assert.equal(result.items.length, 0);
    assert.equal(result.candidates, 0);
  }));

test("结果按 RRF 分数降序", () =>
  withIndex((db) => {
    seed(db);
    const result = searchSegments(db, "连接池", { limit: 10 });
    const scores = result.items.map((item) => item.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  }));

test("read 返回片段全文与会话信息", () =>
  withIndex((db) => {
    seed(db);
    const hit = searchSegments(db, "连接池").items[0];
    const segment = readSegment(db, hit.segmentId);
    assert.equal(segment.sessionId, "ses_a");
    assert.equal(segment.title, "连接池讨论");
    assert.match(segment.text, /连接池/);
    assert.equal(readSegment(db, 999_999), null);
  }));

test("索引状态在同步前明确报告未就绪", () =>
  withIndex((db, path) => {
    seed(db);
    const before = indexStatus(db, { dbPath: path, sourceDb: "/tmp/source.db" });
    assert.equal(before.ready, false);
    assert.equal(before.reason, "未完成同步");
    assert.equal(before.indexedSegments, 4);

    setMeta(db, "last_sync_at", Date.now());
    const after = indexStatus(db, { dbPath: path, sourceDb: "/tmp/source.db" });
    assert.equal(after.ready, true);
    assert.equal(after.indexedSessions, 2);
    assert.equal(after.indexedMessages, 2);
  }));