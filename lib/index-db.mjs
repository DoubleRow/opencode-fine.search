/**
 * 旁路 FTS5 索引：schema、写入、检索、状态。
 *
 * 索引库与 opencode.db 完全分离，删掉即可重建。
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = "1";

export const INDEX_DIR =
  process.env.OC_SEARCH_INDEX_DIR || join(homedir(), ".local/share/opencode-oc-search");

export const INDEX_PATH =
  process.env.OC_SEARCH_INDEX || join(INDEX_DIR, "index.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT '',
  directory    TEXT NOT NULL DEFAULT '',
  parent_id    TEXT,
  time_created INTEGER NOT NULL DEFAULT 0,
  time_updated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS message (
  message_id    TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  type          TEXT NOT NULL,
  time_created  INTEGER NOT NULL DEFAULT 0,
  time_updated  INTEGER NOT NULL DEFAULT 0,
  data_length   INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS message_session ON message(session_id);

CREATE TABLE IF NOT EXISTS segment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ordinal    INTEGER NOT NULL DEFAULT 0,
  kind       TEXT NOT NULL,
  ts         INTEGER NOT NULL DEFAULT 0,
  text       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS segment_message ON segment(message_id);
CREATE INDEX IF NOT EXISTS segment_session ON segment(session_id);
CREATE INDEX IF NOT EXISTS segment_kind ON segment(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS segment_fts USING fts5(
  text,
  content = 'segment',
  content_rowid = 'id',
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS segment_ai AFTER INSERT ON segment BEGIN
  INSERT INTO segment_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS segment_ad AFTER DELETE ON segment BEGIN
  INSERT INTO segment_fts(segment_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS segment_au AFTER UPDATE OF text ON segment BEGIN
  INSERT INTO segment_fts(segment_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO segment_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

function chmodPrivate(path, mode) {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {
    // 权限收紧失败不应阻断索引，状态里仍会给出路径。
  }
}

/**
 * 打开索引库。
 *
 * @param {string} [path]
 * @param {{ create?: boolean, readOnly?: boolean }} [options]
 */
export function openIndex(path = INDEX_PATH, options = {}) {
  const create = options.create !== false;
  const readOnly = options.readOnly === true;

  if (!create && !existsSync(path)) {
    throw new Error(`索引不存在: ${path}`);
  }
  if (create) {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodPrivate(dir, 0o700);
  }

  const db = new DatabaseSync(path, { readOnly });
  try {
    if (!readOnly) {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = NORMAL;");
    }
    db.exec("PRAGMA busy_timeout = 3000;");

    if (create) {
      db.exec(SCHEMA);
      const version = getMeta(db, "schema_version");
      if (version == null) setMeta(db, "schema_version", SCHEMA_VERSION);
      else if (version !== SCHEMA_VERSION) {
        throw new Error(
          `索引版本不匹配（${version} != ${SCHEMA_VERSION}），请删除 ${path} 后重建`,
        );
      }
      if (!readOnly) chmodPrivate(path, 0o600);
    } else {
      const version = getMeta(db, "schema_version");
      if (version == null) {
        throw new Error(`索引缺少 schema_version，文件可能已损坏: ${path}`);
      }
      if (version !== SCHEMA_VERSION) {
        throw new Error(
          `索引版本不匹配（${version} != ${SCHEMA_VERSION}），请删除 ${path} 后重建`,
        );
      }
    }
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // 关闭失败时保留原始错误。
    }
    throw error;
  }
}

export function getMeta(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? String(row.value) : null;
}

export function setMeta(db, key, value) {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}

/** 写入/更新会话元信息。 */
export function upsertSession(db, session) {
  db.prepare(
    `INSERT INTO session(id, title, directory, parent_id, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       directory = excluded.directory,
       parent_id = excluded.parent_id,
       time_created = excluded.time_created,
       time_updated = excluded.time_updated`,
  ).run(
    session.id,
    session.title || "",
    session.directory || "",
    session.parent_id ?? null,
    session.time_created || 0,
    session.time_updated || 0,
  );
}

/** 索引里现有的消息指纹。 */
export function getMessageFingerprints(db) {
  const rows = db.prepare(
    "SELECT message_id, session_id, type, time_created, time_updated, data_length FROM message",
  ).all();
  const map = new Map();
  for (const row of rows) {
    map.set(String(row.message_id), {
      session_id: String(row.session_id),
      type: String(row.type),
      time_created: Number(row.time_created) || 0,
      time_updated: Number(row.time_updated) || 0,
      data_length: Number(row.data_length) || 0,
    });
  }
  return map;
}

export function listIndexSessionIds(db) {
  return new Set(
    db.prepare("SELECT id FROM session").all().map((row) => String(row.id)),
  );
}

/** 删除一条消息及其片段。 */
export function deleteIndexMessage(db, messageId) {
  db.prepare("DELETE FROM segment WHERE message_id = ?").run(messageId);
  db.prepare("DELETE FROM message WHERE message_id = ?").run(messageId);
}

/** 删除一个会话及其全部消息、片段。 */
export function deleteIndexSession(db, sessionId) {
  db.prepare("DELETE FROM segment WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM message WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM session WHERE id = ?").run(sessionId);
}

/** 用新片段整体替换一条消息。 */
export function replaceIndexMessage(db, message, segments) {
  deleteIndexMessage(db, message.id);
  db.prepare(
    `INSERT INTO message(message_id, session_id, type, time_created, time_updated, data_length, segment_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    message.sessionId,
    message.type,
    message.timeCreated || 0,
    message.timeUpdated || 0,
    message.dataLength || 0,
    segments.length,
  );

  const insert = db.prepare(
    `INSERT INTO segment(message_id, session_id, ordinal, kind, ts, text)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  segments.forEach((segment, ordinal) => {
    insert.run(
      message.id,
      message.sessionId,
      ordinal,
      segment.kind,
      message.timeCreated || 0,
      segment.text,
    );
  });
}

/** 索引状态；缺失/损坏必须显式报错，不能伪装成空结果。 */
export function indexStatus(db, options = {}) {
  const dbPath = options.dbPath || INDEX_PATH;
  const sourceDb = options.sourceDb || "";
  const counts = db.prepare(
    `SELECT
       (SELECT count(*) FROM session) AS sessions,
       (SELECT count(*) FROM message) AS messages,
       (SELECT count(*) FROM segment) AS segments`,
  ).get();

  const indexedSessions = Number(counts?.sessions) || 0;
  const indexedMessages = Number(counts?.messages) || 0;
  const indexedSegments = Number(counts?.segments) || 0;
  const lastSyncAt = Number(getMeta(db, "last_sync_at")) || 0;
  const sourceMtime = Number(getMeta(db, "source_mtime")) || 0;
  const ready = indexedSegments > 0 && lastSyncAt > 0;

  return {
    ready,
    reason: ready ? "" : indexedSegments > 0 ? "未完成同步" : "索引为空",
    dbPath,
    sourceDb,
    indexedSessions,
    indexedMessages,
    indexedSegments,
    lastSyncAt,
    sourceMtime,
    error: "",
  };
}

/** 空状态：索引文件不存在或无法打开时使用。 */
export function emptyStatus(reason, options = {}) {
  return {
    ready: false,
    reason,
    dbPath: options.dbPath || INDEX_PATH,
    sourceDb: options.sourceDb || "",
    indexedSessions: 0,
    indexedMessages: 0,
    indexedSegments: 0,
    lastSyncAt: 0,
    sourceMtime: 0,
    error: options.error || "",
  };
}

/** 把用户查询拆成词。 */
export function splitTerms(query) {
  return [...new Set(String(query ?? "").trim().split(/\s+/).filter(Boolean))];
}

function escapeFtsTerm(term) {
  return `"${term.replace(/"/g, '""')}"`;
}

function ftsCandidates(db, terms, options) {
  const match = terms.map(escapeFtsTerm).join(" AND ");
  return db.prepare(
    `SELECT s.id            AS segment_id,
            s.message_id    AS message_id,
            s.session_id    AS session_id,
            s.kind          AS kind,
            s.ts            AS ts,
            s.text          AS text,
            COALESCE(ss.title, '')     AS title,
            COALESCE(ss.directory, '') AS directory,
            bm25(segment_fts)          AS raw_score
     FROM segment_fts
     JOIN segment s ON s.id = segment_fts.rowid
     LEFT JOIN session ss ON ss.id = s.session_id
     WHERE segment_fts MATCH ?
       AND (? = 1 OR s.kind <> 'reasoning')
       AND (? = 1 OR s.kind <> 'tool')
     ORDER BY raw_score
     LIMIT ?`,
  ).all(
    match,
    options.includeReasoning ? 1 : 0,
    options.includeTools ? 1 : 0,
    options.candidateLimit,
  );
}

function likeCandidates(db, terms, options) {
  const where = terms
    .map(() => "instr(lower(s.text), lower(?)) > 0")
    .join(" AND ");
  return db.prepare(
    `SELECT s.id            AS segment_id,
            s.message_id    AS message_id,
            s.session_id    AS session_id,
            s.kind          AS kind,
            s.ts            AS ts,
            s.text          AS text,
            COALESCE(ss.title, '')     AS title,
            COALESCE(ss.directory, '') AS directory,
            0                          AS raw_score
     FROM segment s
     LEFT JOIN session ss ON ss.id = s.session_id
     WHERE ${where}
       AND (? = 1 OR s.kind <> 'reasoning')
       AND (? = 1 OR s.kind <> 'tool')
     ORDER BY s.ts DESC
     LIMIT ?`,
  ).all(
    ...terms,
    options.includeReasoning ? 1 : 0,
    options.includeTools ? 1 : 0,
    options.candidateLimit,
  );
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** 生成命中窗口，并返回关键词在 snippet 内的偏移。 */
export function makeSnippet(text, terms, before = 120, after = 180) {
  const source = String(text ?? "");
  const lower = source.toLowerCase();
  let hitAt = -1;
  let hitTerm = "";
  for (const term of terms) {
    const at = lower.indexOf(term.toLowerCase());
    if (at >= 0 && (hitAt < 0 || at < hitAt)) {
      hitAt = at;
      hitTerm = term;
    }
  }
  if (hitAt < 0) hitAt = 0;

  const start = Math.max(0, hitAt - before);
  const end = Math.min(source.length, hitAt + Math.max(hitTerm.length, 1) + after);
  const window = source.slice(start, end);
  const collapsed = window.replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < source.length ? "…" : "";

  let matchStart = collapsed.toLowerCase().indexOf(hitTerm.toLowerCase());
  if (matchStart < 0) matchStart = 0;
  const snippet = prefix + collapsed + suffix;

  return {
    snippet,
    matchStart: matchStart + prefix.length,
    matchEnd: matchStart + prefix.length + hitTerm.length,
  };
}

/**
 * 分级检索。
 *
 * - 词长 ≥3 走 FTS5 trigram；
 * - 出现 1–2 字词时整体走 LIKE 兜底；
 * - BM25 + 段/会话 RRF(k=60) 排序。
 */
export function searchSegments(db, query, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 20, 100));
  const offset = Math.max(0, Number(options.offset) || 0);
  const includeReasoning = options.includeReasoning === true;
  const includeTools = options.includeTools !== false;
  const terms = splitTerms(query);

  if (!terms.length) {
    return { mode: "none", query: "", terms: [], candidates: 0, items: [] };
  }

  const useFts = terms.every((term) => Array.from(term).length >= 3);
  const candidateLimit = Math.min(Math.max((limit + offset) * 10, 200), 1000);
  const base = {
    includeReasoning,
    includeTools,
    candidateLimit,
  };

  let rows;
  let mode;
  if (useFts) {
    try {
      rows = ftsCandidates(db, terms, base);
      mode = "fts";
    } catch {
      // trigram 对极短/特殊查询会拒绝；退回 LIKE，仍然给出确定结果。
      rows = likeCandidates(db, terms, base);
      mode = "like";
    }
  } else {
    rows = likeCandidates(db, terms, base);
    mode = "like";
  }

  if (mode === "like") {
    const needles = terms.map((term) => term.toLowerCase());
    for (const row of rows) {
      const haystack = String(row.text).toLowerCase();
      let score = 0;
      for (const needle of needles) score += countOccurrences(haystack, needle);
      row.raw_score = score;
    }
  }

  const segmentRank = new Map();
  rows.forEach((row, index) => {
    segmentRank.set(Number(row.segment_id), index + 1);
  });

  // 会话级排序：FTS 取该会话最好（最小）的 BM25；LIKE 取命中总数。
  const sessionAgg = new Map();
  for (const row of rows) {
    const id = String(row.session_id);
    const score = Number(row.raw_score) || 0;
    const current = sessionAgg.get(id);
    if (current === undefined) {
      sessionAgg.set(id, mode === "fts" ? score : score);
    } else if (mode === "fts") {
      if (score < current) sessionAgg.set(id, score);
    } else {
      sessionAgg.set(id, current + score);
    }
  }
  const sessionOrder = [...sessionAgg.entries()].sort((a, b) =>
    mode === "fts" ? a[1] - b[1] : b[1] - a[1],
  );
  const sessionRank = new Map(sessionOrder.map(([id], index) => [id, index + 1]));

  const items = rows.map((row) => {
    const segRank = segmentRank.get(Number(row.segment_id)) || rows.length;
    const sessRank = sessionRank.get(String(row.session_id)) || sessionOrder.length;
    const score = 1 / (60 + segRank) + 1 / (60 + sessRank);
    const { snippet, matchStart, matchEnd } = makeSnippet(String(row.text), terms);
    return {
      segmentId: Number(row.segment_id),
      sessionId: String(row.session_id),
      messageId: String(row.message_id),
      kind: String(row.kind),
      ts: Number(row.ts) || 0,
      title: String(row.title || ""),
      directory: String(row.directory || ""),
      snippet,
      matchStart,
      matchEnd,
      score,
    };
  });

  items.sort((a, b) => b.score - a.score || b.ts - a.ts);

  return {
    mode,
    query: terms.join(" "),
    terms,
    candidates: rows.length,
    items: items.slice(offset, offset + limit),
  };
}

/** 读取一条片段的完整正文。 */
export function readSegment(db, segmentId) {
  const row = db.prepare(
    `SELECT s.id, s.message_id, s.session_id, s.kind, s.ts, s.text,
            m.type AS message_type,
            COALESCE(ss.title, '')     AS title,
            COALESCE(ss.directory, '') AS directory
     FROM segment s
     LEFT JOIN message m ON m.message_id = s.message_id
     LEFT JOIN session ss ON ss.id = s.session_id
     WHERE s.id = ?`,
  ).get(Number(segmentId));

  if (!row) return null;
  return {
    segmentId: Number(row.id),
    messageId: String(row.message_id),
    sessionId: String(row.session_id),
    kind: String(row.kind),
    ts: Number(row.ts) || 0,
    messageType: String(row.message_type || ""),
    title: String(row.title || ""),
    directory: String(row.directory || ""),
    text: String(row.text || ""),
  };
}

/** 索引计数（不含状态判断），供同步结果使用。 */
export function indexCounts(db) {
  const row = db.prepare(
    `SELECT
       (SELECT count(*) FROM session) AS sessions,
       (SELECT count(*) FROM message) AS messages,
       (SELECT count(*) FROM segment) AS segments`,
  ).get();
  return {
    sessions: Number(row?.sessions) || 0,
    messages: Number(row?.messages) || 0,
    segments: Number(row?.segments) || 0,
  };
}