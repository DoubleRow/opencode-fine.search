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

import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

import { extractSegmentsDual } from "../lib/extract.mjs";
import {
  INDEX_PATH,
  deleteIndexMessage,
  deleteIndexSession,
  emptyStatus,
  getIndexSession,
  getMeta,
  getSessionMessageWatermarks,
  getSessionWatermarks,
  getSummary,
  indexCounts,
  indexStatus,
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
const BATCH_SIZE = 500;
const MEMORY_TTL_MS = 10 * 60 * 1000;

/**
 * 积压到这个量级就重建，而不是逐条缝补。
 *
 * 本机实测：顺序重建 1.8 ms/条，就地补丁 47 ms/条（约 25 倍差距），
 * 所以超过这阈值时「另起新库 + 原子换代」既更快，也顺手清掉碎片。
 */
const REBUILD_THRESHOLD = (() => {
  const raw = Number(process.env.OC_SEARCH_REBUILD_THRESHOLD);
  return Number.isInteger(raw) && raw > 0 ? raw : 2000;
})();

let indexDb = null;
let lastSyncCheck = 0;
let memoryCache = { at: 0, map: new Map() };
/** 本进程见过的源库指纹，用于 L0 免查询快速返回。 */
let sigCache = { sig: "" };
/** 计数与代际的内存副本：L0 命中时连这两条统计查询都省掉。 */
let countsCache = null;
let genCache = null;

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

/** 源库 session_part 总行数（旧宿主无表或源库不可读时为 0）。 */
function sourcePartRowCount() {
  try {
    const source = openSource();
    try {
      if (!hasPartTable(source)) return 0;
      const row = source.prepare("SELECT count(*) AS c FROM session_part").get();
      return Number(row?.c) || 0;
    } finally {
      source.close();
    }
  } catch {
    return 0;
  }
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
      partRows: sourcePartRowCount(),
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

/**
 * 源库有没有 `session_part` 表（宿主 2.4.0 起才有）。探测一次，进程内缓存。
 *
 * 旧宿主上该表不存在，part 维度水位恒为 0，同步行为与 v3 一致。
 */
let partTableCache = null;
function hasPartTable(source) {
  if (partTableCache !== null) return partTableCache;
  try {
    const row = source.prepare(
      "SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'session_part'",
    ).get();
    partTableCache = Number(row?.c) > 0;
  } catch {
    partTableCache = false;
  }
  return partTableCache;
}

/**
 * L1 会话水位：每条会话的消息维度 + part 维度（五元组）。
 *
 * 消息部分走 `(session_id, seq)` 索引（本机实测 13 ms）；
 * part 部分走 `(session_id, …)` 聚合（本机实测 < 5 ms）。
 * 源库没有 session_part 表（旧宿主）时 part 维度恒 0。
 */
function readSessionAggregates(source) {
  const rows = source.prepare(
    `SELECT session_id AS id, count(*) AS n, max(seq) AS mx, max(time_updated) AS mt
     FROM session_message GROUP BY session_id`,
  ).all();
  const map = new Map();
  for (const row of rows) {
    map.set(String(row.id), {
      msg_count: Number(row.n) || 0,
      seq_max: Number(row.mx) || 0,
      last_msg_updated: Number(row.mt) || 0,
      part_count: 0,
      part_max_updated: 0,
    });
  }
  if (hasPartTable(source)) {
    const partRows = source.prepare(
      `SELECT session_id AS id, count(*) AS pc, max(time_updated) AS pmt
       FROM session_part GROUP BY session_id`,
    ).all();
    for (const row of partRows) {
      const id = String(row.id);
      const agg = map.get(id);
      if (agg) {
        agg.part_count = Number(row.pc) || 0;
        agg.part_max_updated = Number(row.pmt) || 0;
      } else {
        // 有 part 却没有消息行：外键级联下不该发生，防御性兜底。
        map.set(id, {
          msg_count: 0,
          seq_max: 0,
          last_msg_updated: 0,
          part_count: Number(row.pc) || 0,
          part_max_updated: Number(row.pmt) || 0,
        });
      }
    }
  }
  return map;
}

/** L0 指纹：主库 + WAL 的 (size, mtime) 四元组。 */
function sourceSignature(path = SOURCE_DB) {
  const main = statSync(path);
  let sig = `${main.size}:${Math.floor(main.mtimeMs)}`;
  for (const suffix of ["-wal"]) {
    try {
      const side = statSync(`${path}${suffix}`);
      sig += `|${side.size}:${Math.floor(side.mtimeMs)}`;
    } catch {
      sig += "|0:0";
    }
  }
  return sig;
}

/**
 * 把一条源库消息写进索引（含片段），part 行优先、内联兜底。
 *
 * `idMap` 存在时沿用旧片段 id。返回抽取结果（含路径与 gap 标记），
 * 供同步层做可观测统计。
 */
function writeMessageRow(db, row, idMap, partRows) {
  const segmentsResult = extractSegmentsDual({
    messageRow: {
      id: String(row.id),
      sessionId: String(row.session_id),
      type: String(row.type),
      timeCreated: Number(row.time_created) || 0,
      data: String(row.data),
    },
    partRows: partRows?.get(String(row.id)),
  });
  const { segments, gap, path } = segmentsResult;
  const ids = idMap
    ? segments.map((_, ordinal) => idMap.get(`${String(row.id)}#${ordinal}`))
    : undefined;
  replaceIndexMessage(
    db,
    {
      id: String(row.id),
      sessionId: String(row.session_id),
      type: String(row.type),
      timeCreated: Number(row.time_created) || 0,
      timeUpdated: Number(row.time_updated) || 0,
      dataLength: Number(row.data_length) || 0,
      seq: Number(row.seq) || 0,
    },
    segments,
    ids ? { ids } : undefined,
  );
  return { segments: segments.length, gap, path };
}

/**
 * 批量读 session_part 行（宿主 2.4.0 起的行式存储），按 (message_id, ordinal) 排序。
 *
 * 单条 SQL 的 IN 列表不超过 BATCH_SIZE（500），防 SQLite 变量上限；
 * 源库没有该表（旧宿主）时返回空 Map。
 *
 * @returns {Map<string, { type: string, data: unknown }[]>} message_id → 按 ordinal 升序的 part 行
 */
function readPartRows(source, messageIds) {
  const map = new Map();
  if (!messageIds.length || !hasPartTable(source)) return map;
  const stmt = source.prepare(
    `SELECT message_id, ordinal, type, data
     FROM session_part WHERE message_id IN (${messageIds.map(() => "?").join(", ")})
     ORDER BY message_id, ordinal`,
  );
  for (let offset = 0; offset < messageIds.length; offset += BATCH_SIZE) {
    const batch = messageIds.slice(offset, offset + BATCH_SIZE);
    for (const row of stmt.all(...batch)) {
      const id = String(row.message_id);
      let data = null;
      try {
        data = JSON.parse(String(row.data ?? ""));
      } catch {
        data = null;
      }
      const list = map.get(id);
      const part = { type: String(row.type ?? ""), data };
      if (list) list.push(part);
      else map.set(id, [part]);
    }
  }
  return map;
}

function syncResult(db, extra) {
  const counts = countsCache ?? indexCounts(db);
  return {
    ok: true,
    sourceDb: SOURCE_DB,
    added: 0,
    updated: 0,
    removedMessages: 0,
    removedSessions: 0,
    changed: 0,
    gen: genCache ?? (Number(getMeta(db, "gen")) || 0),
    ...extra,
    ...counts,
  };
}

/** L0 命中：不发任何查询（计数走内存缓存）。 */
function skippedSync(db, startedAt) {
  return syncResult(db, {
    skipped: true,
    mode: "skip",
    elapsedMs: Date.now() - startedAt,
  });
}

/**
 * 全量/增量同步。返回本次改动统计。
 *
 * 三级闸门：
 *   L0 源库文件指纹不变 → 直接返回（不扫表）；
 *   L1 会话水位（条数/最大 seq/最后写入时间）不变 → 跳过该会话；
 *   L2 只对变化会话逐条比对消息水位（不读 data）；
 *   L3 只对真正变化的 id 读正文、重新切片段。
 */
export function sync() {
  const startedAt = Date.now();
  const sourceState = sourceInfo();
  const sig = sourceSignature();
  const db = getIndex();
  const pendingRebuild = getMeta(db, "rebuild_pending") === "1";

  if (!pendingRebuild && sigCache.sig === sig) {
    return skippedSync(db, startedAt);
  }
  if (!pendingRebuild && getMeta(db, "source_sig") === sig) {
    sigCache = { sig };
    return skippedSync(db, startedAt);
  }

  const source = openSource();
  try {
    const sourceSessions = readSessionRows(source);
    const aggregates = readSessionAggregates(source);
    const indexSessions = getSessionWatermarks(db);

    const changedSessions = [];
    const touchedSessionIds = [];
    const sourceSessionIds = new Set();

    for (const session of sourceSessions) {
      const id = String(session.id);
      sourceSessionIds.add(id);
      const agg = aggregates.get(id) ?? {
        msg_count: 0,
        seq_max: 0,
        last_msg_updated: 0,
        part_count: 0,
        part_max_updated: 0,
      };
      const row = {
        id,
        title: session.title || "",
        directory: session.directory || "",
        parent_id: session.parent_id ?? null,
        time_created: Number(session.time_created) || 0,
        time_updated: Number(session.time_updated) || 0,
        msg_count: agg.msg_count,
        seq_max: agg.seq_max,
        last_msg_updated: agg.last_msg_updated,
        part_count: agg.part_count,
        part_max_updated: agg.part_max_updated,
      };
      const old = indexSessions.get(id);
      const drifted =
        !old ||
        old.msg_count !== row.msg_count ||
        old.seq_max !== row.seq_max ||
        old.last_msg_updated !== row.last_msg_updated ||
        old.part_count !== row.part_count ||
        old.part_max_updated !== row.part_max_updated ||
        old.title !== row.title ||
        old.directory !== row.directory ||
        old.parent_id !== row.parent_id ||
        old.time_created !== row.time_created ||
        old.time_updated !== row.time_updated;
      if (drifted) {
        changedSessions.push(row);
        touchedSessionIds.push(id);
      }
    }

    const removedSessions = [];
    for (const id of indexSessions.keys()) {
      if (!sourceSessionIds.has(id)) removedSessions.push(id);
    }

    // L2：只对水位变过的会话逐条比对，不读正文。
    const listSessionMessages = source.prepare(
      `SELECT id, session_id, type, seq, time_created, time_updated,
              length(data) AS data_length
       FROM session_message WHERE session_id = ?`,
    );
    const changedMessages = [];
    const removedMessageIds = [];
    let addedCount = 0;
    let updatedCount = 0;
    for (const sessionId of touchedSessionIds) {
      const rows = listSessionMessages.all(sessionId);
      const old = getSessionMessageWatermarks(db, sessionId);
      const seen = new Set();
      for (const row of rows) {
        const id = String(row.id);
        seen.add(id);
        const prev = old.get(id);
        if (
          !prev ||
          prev.type !== String(row.type) ||
          prev.seq !== (Number(row.seq) || 0) ||
          prev.time_updated !== (Number(row.time_updated) || 0) ||
          prev.data_length !== (Number(row.data_length) || 0)
        ) {
          changedMessages.push(row);
          if (prev) updatedCount += 1;
          else addedCount += 1;
        }
      }
      for (const id of old.keys()) {
        if (!seen.has(id)) removedMessageIds.push(id);
      }
    }

    const counts = indexCounts(db);
    const totalChanges = changedMessages.length + removedMessageIds.length + removedSessions.length;
    if (pendingRebuild || counts.segments === 0 || totalChanges >= REBUILD_THRESHOLD) {
      return rebuildIndex(source, sourceState, sig, startedAt, {
        reason: pendingRebuild
          ? "schema 迁移后首次同步"
          : counts.segments === 0
            ? "索引为空"
            : `积压 ${totalChanges} 条 ≥ 阈值 ${REBUILD_THRESHOLD}`,
        totalChanges,
      });
    }

    db.exec("BEGIN");
    try {
      for (const row of changedSessions) upsertSession(db, row);
      for (const id of removedSessions) deleteIndexSession(db, id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    if (removedMessageIds.length) {
      db.exec("BEGIN");
      try {
        for (const id of removedMessageIds) deleteIndexMessage(db, id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    const fetchMessage = source.prepare(
      `SELECT id, session_id, type, seq, time_created, time_updated,
              length(data) AS data_length, data
       FROM session_message WHERE id = ?`,
    );

    let done = 0;
    let partPathCount = 0;
    let inlinePathCount = 0;
    const gapIds = [];
    for (let offset = 0; offset < changedMessages.length; offset += BATCH_SIZE) {
      const batch = changedMessages.slice(offset, offset + BATCH_SIZE);
      const partRows = readPartRows(source, batch.map((row) => String(row.id)));
      db.exec("BEGIN");
      try {
        for (const row of batch) {
          const full = fetchMessage.get(String(row.id));
          if (!full) continue;
          const result = writeMessageRow(db, full, undefined, partRows);
          if (result.path === "part") partPathCount += 1;
          else if (result.path === "inline") inlinePathCount += 1;
          if (result.gap) gapIds.push(String(row.id));
          done += 1;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      log(`同步进度 ${Math.min(offset + BATCH_SIZE, changedMessages.length)}/${changedMessages.length}`);
    }

    const elapsedMs = Date.now() - startedAt;
    setMeta(db, "last_sync_at", Date.now());
    setMeta(db, "source_path", sourceState.path);
    setMeta(db, "source_mtime", sourceState.mtime);
    setMeta(db, "source_size", sourceState.size);
    setMeta(db, "source_sig", sig);
    setMeta(db, "last_sync_ms", elapsedMs);
    setMeta(db, "last_sync_skipped", "0");
    setMeta(db, "last_gap_count", String(gapIds.length));
    setMeta(db, "last_error", "");
    sigCache = { sig };
    countsCache = indexCounts(db);
    genCache = Number(getMeta(db, "gen")) || 0;

    return syncResult(db, {
      skipped: false,
      mode: "incremental",
      added: addedCount,
      updated: updatedCount,
      removedMessages: removedMessageIds.length,
      removedSessions: removedSessions.length,
      changed: changedMessages.length,
      written: done,
      partPath: partPathCount,
      inlinePath: inlinePathCount,
      gaps: gapIds.length,
      gapSamples: gapIds.slice(0, 10),
      elapsedMs,
    });
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

/**
 * 重建模式：写到 `<索引>.new`，校验通过后原子换代。
 *
 * 失败时删掉半成品、保留旧索引并向上抛错。
 */
function rebuildIndex(source, sourceState, sig, startedAt, detail) {
  const db = getIndex();
  const prevGen = Number(getMeta(db, "gen")) || 0;
  const tempPath = `${INDEX_PATH}.new`;
  removeFile(tempPath);

  const sourceSessions = readSessionRows(source);
  const aggregates = readSessionAggregates(source);
  const oldSegmentIds = readSegmentIdMap(db);
  let fresh = null;
  let written = 0;
  let partPathCount = 0;
  let inlinePathCount = 0;
  const gapIds = [];

  try {
    fresh = openIndex(tempPath);
    // 重建产物是临时文件，校验不过就整个删掉：关掉回滚日志与 fsync 换速度。
    // 本机机械盘上这一步能把 18,900 段的写入从 45 s 压到 20 s 以内。
    fresh.exec("PRAGMA journal_mode = OFF;");
    fresh.exec("PRAGMA synchronous = OFF;");

    fresh.exec("BEGIN");
    try {
      for (const session of sourceSessions) {
        const id = String(session.id);
        const agg = aggregates.get(id) ?? { msg_count: 0, seq_max: 0, last_msg_updated: 0 };
        upsertSession(fresh, {
          id,
          title: session.title || "",
          directory: session.directory || "",
          parent_id: session.parent_id ?? null,
          time_created: Number(session.time_created) || 0,
          time_updated: Number(session.time_updated) || 0,
          msg_count: agg.msg_count,
          seq_max: agg.seq_max,
          last_msg_updated: agg.last_msg_updated,
        });
      }
      fresh.exec("COMMIT");
    } catch (error) {
      fresh.exec("ROLLBACK");
      throw error;
    }

    // 分页读源库正文：单页 BATCH_SIZE 条，避免整会话读进内存。
    const pageStmt = source.prepare(
      `SELECT id, session_id, type, seq, time_created, time_updated,
              length(data) AS data_length, data
       FROM session_message
       WHERE session_id = ? AND seq > ?
       ORDER BY seq
       LIMIT ?`,
    );
    for (const session of sourceSessions) {
      const sessionId = String(session.id);
      let lastSeq = Number.MIN_SAFE_INTEGER;
      while (true) {
        const batch = pageStmt.all(sessionId, lastSeq, BATCH_SIZE);
        if (!batch.length) break;
        const partRows = readPartRows(source, batch.map((row) => String(row.id)));
        fresh.exec("BEGIN");
        try {
          for (const row of batch) {
            const result = writeMessageRow(fresh, row, oldSegmentIds, partRows);
            if (result.path === "part") partPathCount += 1;
            else if (result.path === "inline") inlinePathCount += 1;
            if (result.gap) gapIds.push(String(row.id));
            written += 1;
          }
          fresh.exec("COMMIT");
        } catch (error) {
          fresh.exec("ROLLBACK");
          throw error;
        }
        lastSeq = Number(batch[batch.length - 1].seq) || lastSeq + batch.length;
        log(`重建进度 ${written}`);
      }
    }

    const sourceSessionCount = Number(
      source.prepare("SELECT count(*) AS c FROM session_v2").get()?.c,
    ) || 0;
    const sourceMessageCount = Number(
      source.prepare("SELECT count(*) AS c FROM session_message").get()?.c,
    ) || 0;
    const built = indexCounts(fresh);
    if (built.sessions !== sourceSessionCount || built.messages !== sourceMessageCount) {
      throw new Error(
        `重建校验失败：源库 ${sourceSessionCount} 会话 / ${sourceMessageCount} 消息，` +
          `新索引 ${built.sessions} / ${built.messages}`,
      );
    }

    const elapsedMs = Date.now() - startedAt;
    setMeta(fresh, "gen", prevGen + 1);
    setMeta(fresh, "source_path", sourceState.path);
    setMeta(fresh, "source_mtime", sourceState.mtime);
    setMeta(fresh, "source_size", sourceState.size);
    setMeta(fresh, "source_sig", sig);
    setMeta(fresh, "last_sync_at", Date.now());
    setMeta(fresh, "last_sync_ms", elapsedMs);
    setMeta(fresh, "last_sync_skipped", "0");
    setMeta(fresh, "rebuild_pending", "0");
    setMeta(fresh, "last_gap_count", String(gapIds.length));
    setMeta(fresh, "last_error", "");
  } catch (error) {
    try {
      fresh?.close();
    } catch {
      // 半成品句柄关闭失败不影响清理。
    }
    removeFile(tempPath);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`索引重建失败，旧索引保留：${message}`);
  }

  try {
    fresh.close();
  } catch {
    // 关闭失败不阻断换代：Linux 上 rename 与句柄无关。
  }
  closeIndex();
  // 旧索引的 WAL 附属文件必须先清掉，不能让它挂到新文件上。
  removeFile(`${INDEX_PATH}-wal`);
  removeFile(`${INDEX_PATH}-shm`);

  try {
    renameSync(tempPath, INDEX_PATH);
  } catch (error) {
    removeFile(tempPath);
    getIndex();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`索引换代失败，旧索引保留：${message}`);
  }

  const swapped = getIndex();
  sigCache = { sig };
  countsCache = indexCounts(swapped);
  genCache = prevGen + 1;
  const elapsedMs = Date.now() - startedAt;
  return syncResult(swapped, {
    skipped: false,
    mode: "rebuild",
    reason: detail.reason,
    changed: detail.totalChanges,
    written,
    partPath: partPathCount,
    inlinePath: inlinePathCount,
    gaps: gapIds.length,
    gapSamples: gapIds.slice(0, 10),
    gen: prevGen + 1,
    elapsedMs,
  });
}

/** 现役索引里 (message_id, ordinal) → segment id，重建时沿用，保证重建前后 id 稳定。 */
function readSegmentIdMap(db) {
  try {
    const rows = db.prepare("SELECT id, message_id, ordinal FROM segment").all();
    const map = new Map();
    for (const row of rows) {
      map.set(`${String(row.message_id)}#${Number(row.ordinal) || 0}`, Number(row.id) || 0);
    }
    return map;
  } catch {
    // 旧索引不可读时退回全新 id，不影响正确性。
    return new Map();
  }
}

/** 删掉索引文件及其 WAL 附属文件，容忍不存在。 */
function removeFile(path) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${path}${suffix}`, { force: true });
    } catch {
      // 清理失败由后续报错暴露。
    }
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
  OC_SEARCH_REBUILD_THRESHOLD  积压多少条改走重建（默认 2000）
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
          `  part 行 ${state.partRows}  抽取空洞 ${state.gaps}\n` +
          (state.gaps > 0 && opts.color
            ? `  \x1b[33m⚠ ${state.gaps} 条消息无可抽取内容（可能是存储格式变化）\x1b[0m\n`
            : "") +
          `  索引 ${state.dbPath}\n` +
          `  源库 ${state.sourceDb}\n` +
          (state.lastSyncAt ? `  上次同步 ${formatTime(state.lastSyncAt)}\n` : "") +
          `  生成 ${state.gen}  耗时 ${state.lastSyncMs ? `${state.lastSyncMs} ms` : "—"}` +
          `${state.lastSyncSkipped ? "（空转跳过）" : ""}\n` +
          (state.sourceSig ? `  源库指纹 ${state.sourceSig}\n` : "") +
          (state.error ? `  错误 ${state.error}\n` : ""),
      );
    }
    return 0;
  }

  if (command === "sync") {
    const result = sync();
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.skipped) {
      process.stdout.write(`空转跳过（${result.elapsedMs} ms）：源库文件指纹未变\n`);
    } else {
      const mode = result.mode === "rebuild" ? "重建" : "增量";
      const gapNote = result.gaps > 0
        ? `\n  \x1b[33m⚠ ${result.gaps} 条消息无可抽取内容（可能是存储格式变化）\x1b[0m`
        : "";
      process.stdout.write(
        `同步完成（${mode}${result.reason ? `：${result.reason}` : ""}，${result.elapsedMs} ms）\n` +
          `  新增 ${result.added}  更新 ${result.updated}  删除消息 ${result.removedMessages}  删除会话 ${result.removedSessions}\n` +
          `  part 路径: ${result.partPath ?? 0} 条 / 内联路径: ${result.inlinePath ?? 0} 条 / gap: ${result.gaps ?? 0} 条${gapNote}\n` +
          `  现有 会话 ${result.sessions}  消息 ${result.messages}  片段 ${result.segments}  生成 ${result.gen}\n`,
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
  countsCache = null;
  genCache = null;
  partTableCache = null;
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