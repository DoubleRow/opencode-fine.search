/**
 * 索引 v3.1：session_part 行式存储（宿主 2.4.0 #65039）双源抽取。
 *
 * 全部用临时目录里的合成源库，绝不连真实 opencode.db。
 * 覆盖：part 路径抽取、内联路径逐字节回归、两格式并存、流式补抓、
 * gap 计数、控制类例外、L1 五元组水位。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { extractSegments, extractSegmentsDual } from "../lib/extract.mjs";

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
CREATE TABLE IF NOT EXISTS session_part (
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  type TEXT NOT NULL,
  call_id TEXT,
  time_created INTEGER NOT NULL DEFAULT 0,
  time_updated INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  PRIMARY KEY (message_id, ordinal)
);
`;

function withEnv(fn, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oc-part-rows-"));
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

function search(env, query, limit = 10, options = {}) {
  const args = ["search", query, "--limit", String(limit), "--json", "--no-color"];
  if (options.includeReasoning) args.push("--include-reasoning");
  const res = run(env, args);
  assert.ok(res.status === 0 || res.status === 1, `search 失败: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function openSource(env) {
  const db = new DatabaseSync(env.OPENCODE_DB);
  db.exec(SOURCE_DDL);
  return db;
}

function addSession(db, { id, title, directory = "/w/project", created = 1000, updated = 1000 }) {
  db.prepare(
    `INSERT INTO session_v2(id, title, directory, parent_id, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, title, directory, null, created, updated);
}

function addMessage(db, { id, sessionId, type = "assistant", seq, ts = 1000, data }) {
  db.prepare(
    `INSERT INTO session_message(id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sessionId, type, seq, ts, ts, data);
}

/** 新格式 assistant：content 恒为空数组，正文在 part 行。 */
function emptyAssistantData() {
  return JSON.stringify({ content: [] });
}

function addPart(db, { messageId, sessionId, ordinal, type, ts = 1000, data }) {
  db.prepare(
    `INSERT INTO session_part(message_id, session_id, ordinal, type, call_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(messageId, sessionId, ordinal, type, ts, ts, JSON.stringify(data));
}

const inlineMessageRow = {
  id: "msg_inline",
  sessionId: "ses_a",
  type: "assistant",
  timeCreated: 1000,
  data: JSON.stringify({ content: [{ type: "text", text: "内联路径的正文" }] }),
};

test("纯 part 格式消息抽取正确，kind 映射与内联口径一致", () =>
  withEnv(({ env }) => {
    const db = openSource(env);
    addSession(db, { id: "ses_a", title: "part 会话" });
    addMessage(db, {
      id: "msg_p1",
      sessionId: "ses_a",
      type: "assistant",
      seq: 1,
      data: emptyAssistantData(),
    });
    addPart(db, {
      messageId: "msg_p1",
      sessionId: "ses_a",
      ordinal: 0,
      type: "text",
      data: { type: "text", text: "part 路径的正文" },
    });
    addPart(db, {
      messageId: "msg_p1",
      sessionId: "ses_a",
      ordinal: 1,
      type: "reasoning",
      data: { type: "reasoning", text: "part 路径的思考" },
    });
    addPart(db, {
      messageId: "msg_p1",
      sessionId: "ses_a",
      ordinal: 2,
      type: "tool",
      data: {
        type: "tool",
        id: "call_1",
        name: "shell",
        state: { status: "completed", input: { command: "echo part工具" }, output: "part工具输出" },
      },
    });
    db.close();

    const result = sync(env);
    assert.equal(result.mode, "rebuild");
    assert.equal(result.partPath, 1, "part 路径计数应为 1");
    assert.equal(result.inlinePath, 0);
    assert.equal(result.gaps, 0);

    const kinds = new Set(
      search(env, "part", 20).items.map((item) => item.kind),
    );
    assert.ok(kinds.has("assistant"), "text part → assistant");
    assert.ok(kinds.has("tool"), "tool part → tool");
    assert.ok(
      search(env, "part", 20, { includeReasoning: true }).items.some(
        (item) => item.kind === "reasoning",
      ),
      "reasoning part → reasoning（需显式 includeReasoning）",
    );

    const toolHit = search(env, "part工具").items.find((item) => item.kind === "tool");
    assert.ok(toolHit, "工具参数应可检索");
  }));

test("纯内联格式消息与旧实现输出逐字节一致（回归）", () =>
  withEnv(({ env }) => {
    const db = openSource(env);
    addSession(db, { id: "ses_a", title: "内联会话" });
    addMessage(db, {
      id: inlineMessageRow.id,
      sessionId: "ses_a",
      type: "assistant",
      seq: 1,
      data: inlineMessageRow.data,
    });
    db.close();

    const result = sync(env);
    assert.equal(result.inlinePath, 1, "内联路径计数应为 1");
    assert.equal(result.partPath, 0);
    assert.equal(result.gaps, 0);
    assert.ok(search(env, "内联路径").items.length === 1);

    // lib 层回归：partRows 为空时与 extractSegments 深度相等。
    const dual = extractSegmentsDual({ messageRow: inlineMessageRow, partRows: [] });
    assert.deepEqual(dual.segments, extractSegments(inlineMessageRow));
    assert.equal(dual.gap, false);
    assert.equal(dual.path, "inline");
  }));

test("同一会话两种格式并存时都能抽出", () =>
  withEnv(({ env }) => {
    const db = openSource(env);
    addSession(db, { id: "ses_a", title: "混合会话" });
    addMessage(db, {
      id: "msg_inline",
      sessionId: "ses_a",
      type: "assistant",
      seq: 1,
      data: inlineMessageRow.data,
    });
    addMessage(db, {
      id: "msg_part",
      sessionId: "ses_a",
      type: "assistant",
      seq: 2,
      ts: 2000,
      data: emptyAssistantData(),
    });
    addPart(db, {
      messageId: "msg_part",
      sessionId: "ses_a",
      ordinal: 0,
      type: "text",
      ts: 2000,
      data: { type: "text", text: "part 行的正文" },
    });
    // 新格式 user：文本在顶层 text 字段，content 不存在。
    addMessage(db, {
      id: "msg_user",
      sessionId: "ses_a",
      type: "user",
      seq: 3,
      ts: 3000,
      data: JSON.stringify({ text: "混合会话的提问" }),
    });
    db.close();

    const result = sync(env);
    assert.equal(result.partPath, 1);
    assert.equal(result.inlinePath, 2, "msg_user（顶层 text）也走内联路径");
    assert.equal(result.gaps, 0);
    assert.ok(search(env, "内联路径").items.length === 1, "内联消息应命中");
    assert.ok(search(env, "part 行").items.length === 1, "part 消息应命中");
    assert.ok(search(env, "混合会话的提问").items.length === 1, "新格式 user 顶层 text 应命中");
  }));

test("part 行晚于消息行落库（流式）→ 下一次同步补上", () =>
  withEnv(({ env }) => {
    const db = openSource(env);
    addSession(db, { id: "ses_a", title: "流式会话" });
    addMessage(db, {
      id: "msg_stream",
      sessionId: "ses_a",
      type: "assistant",
      seq: 1,
      data: emptyAssistantData(),
    });
    db.close();

    const first = sync(env);
    assert.equal(first.gaps, 1, "首同步时 part 未落库，应计 gap");
    assert.equal(search(env, "流式补抓").items.length, 0);

    // 宿主写 part 时会推进消息行 time_updated（实测 msg_upd ≥ part_max_upd）。
    const db2 = openSource(env);
    addPart(db2, {
      messageId: "msg_stream",
      sessionId: "ses_a",
      ordinal: 0,
      type: "text",
      ts: 5000,
      data: { type: "text", text: "流式补抓的正文" },
    });
    db2.prepare("UPDATE session_message SET time_updated = 5000 WHERE id = 'msg_stream'").run();
    db2.close();

    const second = sync(env);
    // 索引此前的片段数为 0，本次会按既有语义走重建；不论模式，part 都要补上。
    assert.equal(second.skipped, false);
    assert.equal(second.partPath, 1, "第二次同步应走 part 路径");
    assert.equal(second.gaps, 0);
    assert.equal(search(env, "流式补抓").items.length, 1);
  }));

test("content 与 part 都为空 → gap 计数且不报错", () =>
  withEnv(({ env }) => {
    const db = openSource(env);
    addSession(db, { id: "ses_a", title: "空洞会话" });
    addMessage(db, {
      id: "msg_hole",
      sessionId: "ses_a",
      type: "assistant",
      seq: 1,
      data: emptyAssistantData(),
    });
    db.close();

    const result = sync(env);
    assert.equal(result.mode, "rebuild");
    assert.equal(result.gaps, 1, "应计入 gap");
    assert.deepEqual(result.gapSamples, ["msg_hole"]);
    assert.equal(result.partPath, 0);
    assert.equal(result.inlinePath, 0);

    const state = status(env);
    assert.equal(state.gaps, 1, "status 应上报上次同步的 gap 数");
    assert.ok(state.partRows >= 0, "status 应含 partRows 字段");
  }));

test("控制类 type 与 user 空文本不算 gap", () =>
  withEnv(({ env }) => {
    const db = openSource(env);
    addSession(db, { id: "ses_a", title: "控制类会话" });
    addMessage(db, {
      id: "msg_idle",
      sessionId: "ses_a",
      type: "idle",
      seq: 1,
      data: JSON.stringify({ time: {}, outcome: "stop" }),
    });
    addMessage(db, {
      id: "msg_switch",
      sessionId: "ses_a",
      type: "model-switched",
      seq: 2,
      data: JSON.stringify({ time: {}, model: "m", previous: "p" }),
    });
    // 纯附件 user：无 text 无 displayText。
    addMessage(db, {
      id: "msg_attach",
      sessionId: "ses_a",
      type: "user",
      seq: 3,
      data: JSON.stringify({ files: [{ path: "/tmp/a.png" }] }),
    });
    db.close();

    const result = sync(env);
    assert.equal(result.mode, "rebuild");
    assert.equal(result.gaps, 0, "控制类与附件 user 不算 gap");
    assert.equal(result.inlinePath, 0);
    assert.equal(result.partPath, 0);
  }));

test("水位五元组：只变 part 行会话进入 L2，消息行推进后完成重抽", () =>
  withEnv(({ env }) => {
    const db = openSource(env);
    addSession(db, { id: "ses_a", title: "水位会话" });
    // 加一条有片段的 user 消息，保证索引非空（否则 segments=0 会触发重建兜底，
    // 看不出 L2 部分门的语义）。
    addMessage(db, {
      id: "msg_u",
      sessionId: "ses_a",
      type: "user",
      seq: 1,
      data: JSON.stringify({ text: "水位会话的提问" }),
    });
    addMessage(db, {
      id: "msg_wm",
      sessionId: "ses_a",
      type: "assistant",
      seq: 2,
      data: emptyAssistantData(),
    });
    db.close();

    sync(env);
    // 只插 part 行、不动消息行：L1 五元组必须识别 part 维度变化（不 skip），
    // 但消息行指纹未变，L2 不放行 → 不重抽。
    const db2 = openSource(env);
    addPart(db2, {
      messageId: "msg_wm",
      sessionId: "ses_a",
      ordinal: 0,
      type: "text",
      ts: 5000,
      data: { type: "text", text: "水位会话的正文" },
    });
    db2.close();

    const second = sync(env);
    assert.equal(second.skipped, false, "part 水位变化应让会话进入 L2");
    assert.equal(second.mode, "incremental");
    assert.equal(second.partPath, 0, "消息行指纹未变，L3 不重抽");
    assert.equal(search(env, "水位会话的正文").items.length, 0);

    // 宿主随后推进消息行 time_updated → 完整链路重抽。
    const db3 = openSource(env);
    db3.prepare("UPDATE session_message SET time_updated = 5000 WHERE id = 'msg_wm'").run();
    db3.close();

    const third = sync(env);
    assert.equal(third.mode, "incremental");
    assert.equal(third.partPath, 1, "消息行推进后应走 part 路径重抽");
    assert.equal(search(env, "水位会话的正文").items.length, 1);
  }));
