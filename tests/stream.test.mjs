import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openIndex,
  replaceIndexMessage,
  sessionStream,
  upsertSession,
} from "../lib/index-db.mjs";

function withIndex(fn) {
  const dir = mkdtempSync(join(tmpdir(), "oc-stream-test-"));
  const path = join(dir, "index.db");
  const db = openIndex(path);
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 造一个 60 条片段的会话，便于测分页与锚点。 */
function seed(db) {
  upsertSession(db, {
    id: "ses_stream",
    title: "流水测试",
    directory: "/home/row/project",
    time_created: 1_700_000_000_000,
    time_updated: 1_700_000_000_000,
  });

  for (let message = 0; message < 20; message += 1) {
    replaceIndexMessage(
      db,
      {
        id: `msg_${message}`,
        sessionId: "ses_stream",
        type: "assistant",
        timeCreated: 1_700_000_000_000 + message,
        timeUpdated: 1_700_000_000_000 + message,
        dataLength: 10,
      },
      [
        { kind: "assistant", text: `第 ${message} 条回复正文` },
        { kind: "reasoning", text: `第 ${message} 条思考` },
        { kind: "tool", text: `第 ${message} 条工具输出` },
      ],
    );
  }
}

test("会话不存在时返回 null", () =>
  withIndex((db) => {
    seed(db);
    assert.equal(sessionStream(db, "ses_missing"), null);
  }));

test("默认从第一条开始，按 id 升序", () =>
  withIndex((db) => {
    seed(db);
    const page = sessionStream(db, "ses_stream", { limit: 5 });
    assert.equal(page.total, 60);
    assert.equal(page.offset, 0);
    assert.equal(page.anchorIndex, -1);
    assert.equal(page.hasMore, true);
    assert.equal(page.items.length, 5);
    const ids = page.items.map((item) => item.segmentId);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.equal(page.items[0].kind, "assistant");
    assert.equal(page.items[1].kind, "reasoning");
  }));

test("锚点：返回命中下标并把首页定位到命中附近", () =>
  withIndex((db) => {
    seed(db);
    const all = sessionStream(db, "ses_stream", { limit: 80 });
    const anchor = all.items[40];
    const page = sessionStream(db, "ses_stream", {
      limit: 10,
      anchorSegmentId: anchor.segmentId,
    });
    assert.equal(page.anchorIndex, 40);
    // limit 10 → 首页从 40 - 5 开始。
    assert.equal(page.offset, 35);
    assert.ok(page.items.some((item) => item.segmentId === anchor.segmentId));
  }));

test("显式 offset 优先于锚点，且能取到最后一页", () =>
  withIndex((db) => {
    seed(db);
    const page = sessionStream(db, "ses_stream", { offset: 55, limit: 10 });
    assert.equal(page.offset, 55);
    assert.equal(page.items.length, 5);
    assert.equal(page.hasMore, false);

    const clamped = sessionStream(db, "ses_stream", { offset: 500, limit: 10 });
    assert.equal(clamped.offset, 59);
    assert.equal(clamped.items.length, 1);
    assert.equal(clamped.hasMore, false);
  }));

test("单条按 maxChars 截断，length 保留原文长度", () =>
  withIndex((db) => {
    upsertSession(db, {
      id: "ses_long",
      title: "长文本",
      directory: "/p",
      time_created: 1,
      time_updated: 1,
    });
    replaceIndexMessage(
      db,
      {
        id: "msg_long",
        sessionId: "ses_long",
        type: "assistant",
        timeCreated: 1,
        timeUpdated: 1,
        dataLength: 5000,
      },
      [{ kind: "tool", text: "x".repeat(5000) }],
    );

    const page = sessionStream(db, "ses_long", { maxChars: 1000 });
    const item = page.items[0];
    assert.equal(item.text.length, 1000);
    assert.equal(item.length, 5000);
    assert.equal(item.truncated, true);
  }));

test("空会话返回空页而不是报错", () =>
  withIndex((db) => {
    upsertSession(db, {
      id: "ses_empty",
      title: "空",
      directory: "/p",
      time_created: 1,
      time_updated: 1,
    });
    const page = sessionStream(db, "ses_empty");
    assert.equal(page.total, 0);
    assert.deepEqual(page.items, []);
    assert.equal(page.hasMore, false);
  }));