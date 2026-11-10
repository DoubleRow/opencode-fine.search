#!/usr/bin/env node
/**
 * oc-search sidecar — 建库与检索的 Node 进程。
 *
 * 两种运行方式：
 *   1. 常驻：node worker.mjs --serve      （stdin/stdout 行式 JSON-RPC，供 server 插件调用）
 *   2. 单次：node worker.mjs sync|status|search|read …（验收与脚本）
 *
 * 只读打开 opencode.db；只写 ~/.local/share/opencode-oc-search/index.db。
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

import { extractSegments, fingerprintOf } from "../lib/extract.mjs";
import {
  INDEX_PATH,
  deleteIndexMessage,
  deleteIndexSession,
  emptyStatus,
  getIndexSession,
  getMessageFingerprints,
  getSummary,
  indexCounts,
  indexStatus,
  listIndexSessionIds,
  openIndex,
  readSegment,
  replaceIndexMessage,
  saveSummary,
  searchSegments,
  sessionStream,
  setMeta,
  upsertSession,
} from "../lib/index-db.mjs";
import {
  autoSummary,
  chooseSummary,
  fetchMemorySummaries,
  projectName,
} from "../lib/summary.mjs";

const SOURCE_DB =
  process.env.OPENCODE_DB || join(homedir(), ".local/share/opencode", "opencode.db");

const SYNC_INTERVAL_MS = 10_000;
const BATCH_SIZE = 200;
const MEMORY_TTL_MS = 10 * 60 * 1000;

let indexDb = null;
let lastSyncCheck = 0;
let memoryCache = { at: 0, map: new Map() };

function log(message) {
  if (process.env.OC_SEARCH_VERBOSE === "1") {
    process.stderr.write(`${message}\n`);
  }
}

function sourcedError(message, code = "internal") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sourceInfo() {
  if (!existsSync(SOURCE_DB)) {
    throw sourcedError(`找不到 OpenCode 会话库: ${SOURCE_DB}`, "not_ready");
  }
  const stat = statSync(SOURCE_DB);
  return { path: SOURCE_DB, mtime: Math.floor(stat.mtimeMs), size: stat.size };
}

function openSource() {
  sourceInfo();
  try {
    return new DatabaseSync(SOURCE_DB, { readOnly: true });
  } catch (error) {
    throw sourcedError(
      `无法只读打开会话库: ${SOURCE_DB}\n${error instanceof Error ? error.message : String(error)}`,
      "not_ready",
    );
  }
}

function getIndex() {
  if (!indexDb) {
    try {
      indexDb = openIndex(INDEX_PATH);
    } catch (error) {
      throw sourcedError(
        `索引不可用: ${error instanceof Error ? error.message : String(error)}`,
        "not_ready",
      );
    }
  }
  return indexDb;
}

/** 当前索引状态，不创建文件。 */
export function status() {
  let source;
  try {
    source = sourceInfo();
  } catch (error) {
    return emptyStatus("找不到会话库", {
      dbPath: INDEX_PATH,
      sourceDb: SOURCE_DB,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!existsSync(INDEX_PATH)) {
    return emptyStatus("索引不存在", {
      dbPath: INDEX_PATH,
      sourceDb: source.path,
    });
  }

  let db;
  try {
    db = openIndex(INDEX_PATH, { create: false, readOnly: true });
    const state = indexStatus(db, {
      dbPath: INDEX_PATH,
      sourceDb: source.path,
    });
    db.close();
    return state;
  } catch (error) {
    try {
      db?.close();
    } catch {
      // 忽略关闭错误。
    }
    return emptyStatus("索引不可用", {
      dbPath: INDEX_PATH,
      sourceDb: source.path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function readSessionRows(source) {
  return source.prepare(
    `SELECT id, title, directory, parent_id, time_created, time_updated
     FROM session_v2`,
  ).all();
}

function readMessageRows(source) {
  return source.prepare(
    `SELECT id, session_id, type, time_created, time_updated,
            length(data) AS data_length
     FROM session_message`,
  ).all();
}

/**
 * 全量/增量同步。返回本次改动统计。
 */
export function sync() {
  // 先拿索引连接；源库打开失败时索引句柄仍可复用。
  const db = getIndex();
  const source = openSource();
  const startedAt = Date.now();
  const sourceState = sourceInfo();

  try {
    const sourceSessions = readSessionRows(source);
    const sourceMessages = readMessageRows(source);
    const existing = getMessageFingerprints(db);
    const existingSessions = listIndexSessionIds(db);

    const sourceMessageIds = new Set();
    const sourceSessionIds = new Set();
    const changed = [];
    let added = 0;
    let updated = 0;

    for (const session of sourceSessions) {
      sourceSessionIds.add(String(session.id));
    }

    for (const row of sourceMessages) {
      const id = String(row.id);
      sourceMessageIds.add(id);
      const old = existing.get(id);
      if (
        !old ||
        old.session_id !== String(row.session_id) ||
        old.type !== String(row.type) ||
        fingerprintOf(old) !== fingerprintOf(row)
      ) {
        changed.push(row);
        if (old) updated += 1;
        else added += 1;
      }
    }

    const removedMessages = [];
    for (const id of existing.keys()) {
      if (!sourceMessageIds.has(id)) removedMessages.push(id);
    }

    const removedSessions = [];
    for (const id of existingSessions) {
      if (!sourceSessionIds.has(id)) removedSessions.push(id);
    }

    // 会话元信息量小，直接整体覆盖。
    db.exec("BEGIN");
    try {
      for (const session of sourceSessions) upsertSession(db, session);
      for (const id of removedSessions) deleteIndexSession(db, id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    for (const id of removedMessages) deleteIndexMessage(db, id);

    const fetchMessage = source.prepare(
      `SELECT id, session_id, type, time_created, time_updated,
              length(data) AS data_length, data
       FROM session_message WHERE id = ?`,
    );

    let done = 0;
    for (let offset = 0; offset < changed.length; offset += BATCH_SIZE) {
      const batch = changed.slice(offset, offset + BATCH_SIZE);
      db.exec("BEGIN");
      try {
        for (const row of batch) {
          const full = fetchMessage.get(String(row.id));
          if (!full) continue;
          const segments = extractSegments({
            id: String(full.id),
            sessionId: String(full.session_id),
            type: String(full.type),
            timeCreated: Number(full.time_created) || 0,
            data: String(full.data),
          });
          replaceIndexMessage(
            db,
            {
              id: String(full.id),
              sessionId: String(full.session_id),
              type: String(full.type),
              timeCreated: Number(full.time_created) || 0,
              timeUpdated: Number(full.time_updated) || 0,
              dataLength: Number(full.data_length) || 0,
            },
            segments,
          );
          done += 1;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      log(`同步进度 ${Math.min(offset + BATCH_SIZE, changed.length)}/${changed.length}`);
    }

    setMeta(db, "last_sync_at", Date.now());
    setMeta(db, "source_path", sourceState.path);
    setMeta(db, "source_mtime", sourceState.mtime);
    setMeta(db, "source_size", sourceState.size);
    setMeta(db, "last_error", "");

    const counts = indexCounts(db);
    const elapsedMs = Date.now() - startedAt;
    return {
      ok: true,
      sourceDb: sourceState.path,
      added,
      updated,
      removedMessages: removedMessages.length,
      removedSessions: removedSessions.length,
      changed: changed.length,
      elapsedMs,
      ...counts,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      setMeta(db, "last_error", message);
    } catch {
      // 索引不可写时保留原始错误。
    }
    throw error;
  } finally {
    source.close();
  }
}

/** 首次使用或索引过期时自动同步。 */
function ensureFresh(options = {}) {
  const force = options.force === true;
  if (force) return sync();

  const now = Date.now();
  if (now - lastSyncCheck < 1000) return null;
  lastSyncCheck = now;

  const state = status();
  if (!state.ready) return sync();
  if (now - (state.lastSyncAt || 0) > SYNC_INTERVAL_MS) return sync();
  return null;
}

function doSearch(params = {}) {
  ensureFresh({ force: params.forceSync === true });
  const db = getIndex();
  return searchSegments(db, params.query, {
    limit: params.limit,
    offset: params.offset,
    includeReasoning: params.includeReasoning === true,
    includeTools: params.includeTools !== false,
  });
}

function doStream(params = {}) {
  ensureFresh();
  const db = getIndex();
  const sessionId = String(params.sessionId ?? "").trim();
  if (!sessionId) {
    const error = new Error("sessionId 无效");
    error.code = "not_found";
    throw error;
  }

  const result = sessionStream(db, sessionId, {
    offset: params.offset,
    limit: params.limit,
    anchorSegmentId: params.anchorSegmentId,
    maxChars: params.maxChars,
  });
  if (!result) {
    const error = new Error(`会话不在索引中: ${sessionId}`);
    error.code = "not_found";
    throw error;
  }
  return result;
}

function doRead(params = {}) {
  const db = getIndex();
  const segmentId = Number(params.segmentId);
  if (!Number.isInteger(segmentId) || segmentId <= 0) {
    throw new Error(`segmentId 无效: ${params.segmentId}`);
  }
  return readSegment(db, segmentId);
}

async function getMemoryMap() {
  if (Date.now() - memoryCache.at < MEMORY_TTL_MS) return memoryCache.map;
  const map = await fetchMemorySummaries();
  memoryCache = { at: Date.now(), map };
  return map;
}

function segmentText(db, sessionId, kind, direction) {
  const row = db.prepare(
    `SELECT text FROM segment
     WHERE session_id = ? AND kind = ?
     ORDER BY ts ${direction}, id ${direction}
     LIMIT 1`,
  ).get(String(sessionId), String(kind));
  return row ? String(row.text || "") : "";
}

function projectStats(db, project, fallbackUpdated) {
  const rows = db.prepare("SELECT directory, time_updated FROM session").all();
  let count = 0;
  let lastActive = 0;
  for (const row of rows) {
    if (projectName(row.directory) !== project) continue;
    count += 1;
    lastActive = Math.max(lastActive, Number(row.time_updated) || 0);
  }
  if (!count) {
    count = 1;
    lastActive = fallbackUpdated || 0;
  }
  return { count, lastActive };
}

async function doSummary(params = {}) {
  ensureFresh();
  const db = getIndex();
  const sessionId = String(params.sessionId ?? "").trim();
  if (!sessionId) {
    const error = new Error("sessionId 无效");
    error.code = "not_found";
    throw error;
  }

  const session = getIndexSession(db, sessionId);
  if (!session) {
    const error = new Error(`会话不在索引中: ${sessionId}`);
    error.code = "not_found";
    throw error;
  }

  const auto = autoSummary({
    title: session.title,
    directory: session.directory,
    firstUser: segmentText(db, sessionId, "user", "ASC"),
    lastAssistant: segmentText(db, sessionId, "assistant", "DESC"),
    lastTool: segmentText(db, sessionId, "tool", "DESC"),
  });

  const stored = getSummary(db, sessionId);
  const memories = await getMemoryMap();
  const memory = memories.get(sessionId) ?? null;
  const chosen = chooseSummary({
    stored,
    memory,
    auto,
    sessionUpdated: session.time_updated,
  });

  if (chosen.source === "auto") {
    const changed =
      !stored ||
      stored.source !== "auto" ||
      stored.project !== chosen.project ||
      stored.doing !== chosen.doing ||
      stored.solved !== chosen.solved ||
      stored.updatedAt < (session.time_updated || 0);
    if (changed) {
      saveSummary(db, {
        sessionId,
        source: "auto",
        project: chosen.project,
        doing: chosen.doing,
        solved: chosen.solved,
        updatedAt: Date.now(),
      });
    }
  }

  const stats = projectStats(db, chosen.project, session.time_updated);
  return {
    source: chosen.source,
    project: chosen.project,
    doing: chosen.doing,
    solved: chosen.solved,
    sessionCount: stats.count,
    lastActive: stats.lastActive,
  };
}

// ---------- 单次 CLI ----------

const USAGE = `用法:
  node plugin/worker.mjs status [--json]
  node plugin/worker.mjs sync [--json]
  node plugin/worker.mjs search <关键词...> [选项]
  node plugin/worker.mjs read <segmentId> [--json]
  node plugin/worker.mjs summary <sessionId> [--json]
  node plugin/worker.mjs stream <sessionId> [--limit N] [--anchor N] [--json]
  node plugin/worker.mjs --serve

search 选项:
  --limit <n>           最多输出条数（默认 20）
  --include-reasoning   也搜思考过程
  --no-tools            不搜工具调用内容
  --json                输出 JSON
  --no-color            关闭关键词高亮

环境变量:
  OPENCODE_DB           覆盖会话库路径
  OC_SEARCH_INDEX       覆盖索引文件路径
  OC_SEARCH_VERBOSE=1   输出同步进度到 stderr
`;

function parseArgs(argv) {
  const opts = {
    json: false,
    limit: 20,
    includeReasoning: false,
    includeTools: true,
    color: process.stdout.isTTY && !process.env.NO_COLOR,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--include-reasoning") opts.includeReasoning = true;
    else if (arg === "--no-tools") opts.includeTools = false;
    else if (arg === "--no-color") opts.color = false;
    else if (arg === "--anchor") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--anchor 需要一个正整数片段 id");
      }
      opts.anchor = value;
    }
    else if (arg === "--limit") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--limit 需要一个正整数");
      }
      opts.limit = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`未知选项: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { opts, positional };
}

function highlight(text, terms, enabled) {
  if (!enabled) return text;
  let out = text;
  for (const term of terms) {
    if (!term) continue;
    out = out.split(term).join(`\x1b[1;33m${term}\x1b[0m`);
  }
  return out;
}

function formatTime(ts) {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

const KIND_LABEL = {
  user: "用户",
  assistant: "回复",
  reasoning: "思考",
  tool: "工具",
  system: "系统",
  synthetic: "合成",
  compaction: "摘要",
};

const SOURCE_LABEL = {
  llm: "LLM",
  memory: "记忆",
  auto: "自动",
};

async function runCli(argv) {
  if (argv[0] === "--serve" || argv[0] === "serve") {
    return serve();
  }

  const command = argv[0];
  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }

  // 参数错误属于用法问题，按项目约定返回 2（与未知命令一致），不混进运行时失败的 1。
  let parsed;
  try {
    parsed = parseArgs(argv.slice(1));
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n\n${USAGE}`);
    return 2;
  }
  const { opts, positional } = parsed;

  if (command === "status") {
    const state = status();
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${state.ready ? "就绪" : "未就绪"}  ${state.reason || "索引可用"}\n` +
          `  会话 ${state.indexedSessions}  消息 ${state.indexedMessages}  片段 ${state.indexedSegments}\n` +
          `  索引 ${state.dbPath}\n` +
          `  源库 ${state.sourceDb}\n` +
          (state.lastSyncAt ? `  上次同步 ${formatTime(state.lastSyncAt)}\n` : "") +
          (state.error ? `  错误 ${state.error}\n` : ""),
      );
    }
    return 0;
  }

  if (command === "sync") {
    const result = sync();
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `同步完成（${result.elapsedMs} ms）\n` +
          `  新增 ${result.added}  更新 ${result.updated}  删除消息 ${result.removedMessages}  删除会话 ${result.removedSessions}\n` +
          `  现有 会话 ${result.sessions}  消息 ${result.messages}  片段 ${result.segments}\n`,
      );
    }
    return 0;
  }

  if (command === "search") {
    const query = positional.join(" ").trim();
    if (!query) {
      process.stderr.write(`search 需要关键词\n\n${USAGE}`);
      return 2;
    }
    const result = doSearch({
      query,
      limit: opts.limit,
      includeReasoning: opts.includeReasoning,
      includeTools: opts.includeTools,
    });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (!result.items.length) {
      process.stdout.write(
        `没有命中：${query}（模式 ${result.mode}，候选 ${result.candidates}）\n`,
      );
    } else {
      process.stdout.write(
        `命中 ${result.items.length} 条（候选 ${result.candidates}，模式 ${result.mode}）\n\n`,
      );
      for (const item of result.items) {
        process.stdout.write(
          `${formatTime(item.ts)}  ${KIND_LABEL[item.kind] || item.kind}  ${item.title || "(无标题)"}\n` +
            `  ${item.directory}  ${item.sessionId}\n` +
            `  ${highlight(item.snippet, result.terms, opts.color)}\n\n`,
        );
      }
    }
    return result.items.length ? 0 : 1;
  }

  if (command === "summary") {
    const sessionId = positional[0];
    if (!sessionId) {
      process.stderr.write(`summary 需要 sessionId\n\n${USAGE}`);
      return 2;
    }
    const result = await doSummary({ sessionId });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `来源 ${SOURCE_LABEL[result.source] || result.source}\n` +
          `  大项目 ${result.project} · ${result.sessionCount} 个会话` +
          (result.lastActive ? ` · 最近活跃 ${formatTime(result.lastActive)}` : "") +
          `\n  当时在做 ${result.doing}\n  解决 ${result.solved}\n`,
      );
    }
    return 0;
  }

  if (command === "stream") {
    const sessionId = positional[0];
    if (!sessionId) {
      process.stderr.write(`stream 需要 sessionId\n\n${USAGE}`);
      return 2;
    }
    const result = doStream({
      sessionId,
      limit: opts.limit,
      anchorSegmentId: opts.anchor,
    });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${result.title || "(无标题会话)"} · 共 ${result.total} 条片段，本页 ${result.offset + 1}-${result.offset + result.items.length}` +
          (result.anchorIndex >= 0 ? ` · 命中下标 ${result.anchorIndex}` : "") +
          `\n`,
      );
      for (const item of result.items) {
        const text = item.text.replace(/\s+/g, " ").slice(0, 80);
        process.stdout.write(`  ${String(item.segmentId).padStart(6)}  ${KIND_LABEL[item.kind] || item.kind}  ${text}\n`);
      }
    }
    return 0;
  }

  if (command === "read") {
    const id = positional[0];
    if (!id) {
      process.stderr.write(`read 需要 segmentId\n\n${USAGE}`);
      return 2;
    }
    const result = doRead({ segmentId: id });
    if (!result) {
      process.stderr.write(`没有这条片段: ${id}\n`);
      return 1;
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `${formatTime(result.ts)}  ${KIND_LABEL[result.kind] || result.kind}  ${result.title || "(无标题)"}\n` +
          `  ${result.directory}  ${result.sessionId}  #${result.segmentId}\n\n${result.text}\n`,
      );
    }
    return 0;
  }

  process.stderr.write(`未知命令: ${command}\n\n${USAGE}`);
  return 2;
}

// ---------- 常驻 JSON-RPC ----------

async function handleRequest(request) {
  const method = request?.method;
  const params = request?.params && typeof request.params === "object" ? request.params : {};

  switch (method) {
    case "status":
      return status();
    case "sync":
      return sync();
    case "search":
      return doSearch(params);
    case "summary":
      return doSummary(params);
    case "stream":
      return doStream(params);
    case "read": {
      const result = doRead(params);
      if (!result) {
        const error = new Error(`没有这条片段: ${params.segmentId}`);
        error.code = "not_found";
        throw error;
      }
      return result;
    }
    default: {
      const error = new Error(`未知方法: ${method}`);
      error.code = "unknown_method";
      throw error;
    }
  }
}

async function serve() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  process.stderr.write(`oc-search sidecar 就绪，索引 ${INDEX_PATH}\n`);

  for await (const line of lines) {
    const text = line.trim();
    if (!text) continue;

    let request;
    try {
      request = JSON.parse(text);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ id: null, ok: false, error: { code: "bad_json", message: "请求不是合法 JSON" } })}\n`,
      );
      continue;
    }

    try {
      const result = await handleRequest(request);
      process.stdout.write(`${JSON.stringify({ id: request.id ?? null, ok: true, result })}\n`);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          id: request.id ?? null,
          ok: false,
          error: {
            code: error?.code || "internal",
            message: error instanceof Error ? error.message : String(error),
          },
        })}\n`,
      );
    }
  }

  closeIndex();
  return 0;
}

function closeIndex() {
  try {
    indexDb?.close();
  } catch {
    // 退出路径上忽略关闭错误。
  }
  indexDb = null;
}

async function main() {
  const argv = process.argv.slice(2);
  // 用 exitCode 而不是 process.exit：大 JSON 输出走管道时，立即退出可能丢掉尾部未刷出的数据。
  try {
    if (argv[0] === "--serve" || argv[0] === "serve") {
      const code = await serve();
      closeIndex();
      process.exitCode = code;
      return;
    }

    const code = await runCli(argv);
    closeIndex();
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(`oc-search 失败: ${error?.message || error}\n`);
    closeIndex();
    process.exitCode = 1;
  }
}

process.on("SIGTERM", () => {
  closeIndex();
  process.exit(0);
});
process.on("SIGINT", () => {
  closeIndex();
  process.exit(0);
});

main();