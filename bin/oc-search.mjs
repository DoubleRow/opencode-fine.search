#!/usr/bin/env node
/**
 * oc-search — 只读检索 OpenCode 本地会话库
 *
 * 直接读取 ~/.local/share/opencode/opencode.db（SQLite，只读模式），
 * 在 session_message.data 的 JSON 文本里做关键词匹配，输出带上下文的片段。
 *
 * 不写入、不修改数据库；不联网。
 */

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_PATH =
  process.env.OPENCODE_DB || join(homedir(), ".local/share/opencode", "opencode.db");

const USAGE = `用法:
  oc-search <关键词...> [选项]

选项:
  --any               多个关键词取「或」（默认「且」）
  --limit <n>         最多输出条数（默认 20）
  --session <id>      限定会话 ID（前缀匹配）
  --dir <path>        限定会话目录（子串匹配）
  --type user|assistant  限定消息类型
  --since <YYYY-MM-DD>    只看该日期之后
  --include-reasoning 也搜思考过程（默认跳过，噪声大）
  --no-tools          不搜工具调用内容
  --json              输出 JSON
  --list              列出全部会话，不搜索
  --no-color          关闭关键词高亮
  -h, --help          显示本帮助

示例:
  oc-search 向量化
  oc-search 向量化 webui --any --limit 5
  oc-search embedding --since 2026-10-20
  oc-search 随机森林 --dir 考研
  oc-search --list
`;

// ---------- 参数解析 ----------

const argv = process.argv.slice(2);
const opts = {
  any: false,
  limit: 20,
  session: null,
  dir: null,
  type: null,
  since: null,
  includeReasoning: false,
  noTools: false,
  json: false,
  list: false,
  color: process.stdout.isTTY && !process.env.NO_COLOR,
};
const terms = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") {
    process.stdout.write(USAGE);
    process.exit(0);
  } else if (a === "--any") opts.any = true;
  else if (a === "--include-reasoning") opts.includeReasoning = true;
  else if (a === "--no-tools") opts.noTools = true;
  else if (a === "--json") opts.json = true;
  else if (a === "--list") opts.list = true;
  else if (a === "--no-color") opts.color = false;
  else if (a === "--limit") opts.limit = Number(argv[++i]) || 20;
  else if (a === "--session") opts.session = argv[++i] || null;
  else if (a === "--dir") opts.dir = argv[++i] || null;
  else if (a === "--type") opts.type = argv[++i] || null;
  else if (a === "--since") opts.since = argv[++i] || null;
  else if (a.startsWith("-")) {
    process.stderr.write(`未知选项: ${a}\n\n${USAGE}`);
    process.exit(2);
  } else terms.push(a);
}

// ---------- 数据库 ----------

let db;
try {
  db = new DatabaseSync(DB_PATH, { readOnly: true });
} catch (e) {
  process.stderr.write(`无法只读打开数据库: ${DB_PATH}\n${e.message}\n`);
  process.exit(1);
}

// ---------- 列表模式 ----------

if (opts.list) {
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.directory, s.time_created,
              (SELECT count(*) FROM session_message m WHERE m.session_id = s.id) msgs
       FROM session_v2 s ORDER BY s.time_created DESC`,
    )
    .all();
  if (opts.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  } else {
    for (const r of rows) {
      const d = new Date(r.time_created).toISOString().slice(0, 16).replace("T", " ");
      process.stdout.write(
        `${d}  ${String(r.msgs).padStart(4)}条  ${(r.title || "(无标题)").slice(0, 32)}  ${r.directory}  ${r.id}\n`,
      );
    }
  }
  process.exit(0);
}

if (!terms.length) {
  process.stderr.write(USAGE);
  process.exit(2);
}

// ---------- 文本抽取 ----------

function walkStrings(node, push, depth = 0) {
  if (depth > 8 || node == null) return;
  if (typeof node === "string") {
    push("", node);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) walkStrings(v, push, depth + 1);
    return;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node)) walkStrings(v, push, depth + 1);
  }
}

/** 把一条消息拆成若干可搜索片段 {kind, text} */
function extractParts(raw, type) {
  const parts = [];
  let j = null;
  try {
    j = JSON.parse(raw);
  } catch {
    return [{ kind: type, text: raw }];
  }

  if (j?.metadata?.displayText) {
    parts.push({ kind: "user", text: j.metadata.displayText });
  }
  if (Array.isArray(j?.content)) {
    for (const c of j.content) {
      if (c?.type === "text" && typeof c.text === "string") {
        parts.push({ kind: "text", text: c.text });
      } else if (c?.type === "reasoning" && typeof c.text === "string") {
        parts.push({ kind: "reasoning", text: c.text });
      }
    }
  }

  // 工具调用等其它结构：兜底递归，标记为 tool
  if (!parts.length || type === "tool") {
    walkStrings(j, (_, s) => {
      if (s.trim().length > 0) parts.push({ kind: "tool", text: s });
    });
  }
  return parts;
}

const KIND_LABEL = {
  user: "用户",
  text: "回复",
  reasoning: "思考",
  tool: "工具",
  assistant: "回复",
};

// ---------- 检索 ----------

const sinceMs = opts.since ? Date.parse(opts.since + "T00:00:00Z") : null;
if (opts.since && Number.isNaN(sinceMs)) {
  process.stderr.write(`--since 日期无法解析: ${opts.since}\n`);
  process.exit(2);
}

const sql = `
  SELECT m.session_id sid, m.type, m.time_created ts, m.data d,
         s.title, s.directory
  FROM session_message m
  LEFT JOIN session_v2 s ON s.id = m.session_id
  ORDER BY m.time_created DESC
`;

const rows = db.prepare(sql).all();
const hits = [];

for (const r of rows) {
  if (opts.type && r.type !== opts.type) continue;
  if (opts.session && !r.sid.startsWith(opts.session)) continue;
  if (opts.dir && !(r.directory || "").includes(opts.dir)) continue;
  if (sinceMs && r.ts < sinceMs) continue;

  for (const p of extractParts(r.d, r.type)) {
    if (p.kind === "reasoning" && !opts.includeReasoning) continue;
    if (p.kind === "tool" && opts.noTools) continue;

    const text = p.text;
    const matched = opts.any
      ? terms.filter((t) => text.includes(t))
      : terms.every((t) => text.includes(t)) && terms;

    if (!matched || (Array.isArray(matched) && !matched.length)) continue;

    const first = matched[0];
    const idx = text.indexOf(first);
    const start = Math.max(0, idx - 120);
    const end = Math.min(text.length, idx + first.length + 180);

    hits.push({
      time: new Date(r.ts).toISOString().slice(0, 16).replace("T", " "),
      ts: r.ts,
      session: r.sid,
      title: r.title || "(无标题)",
      directory: r.directory || "",
      type: r.type,
      kind: p.kind,
      snippet:
        (start > 0 ? "…" : "") +
        text.slice(start, end).replace(/\s+/g, " ").trim() +
        (end < text.length ? "…" : ""),
      matched,
    });
    break; // 一条消息只报一次
  }
  if (hits.length >= opts.limit) break;
}

// ---------- 输出 ----------

function highlight(s, terms, on) {
  if (!on) return s;
  let out = s;
  for (const t of terms) out = out.split(t).join(`\x1b[1;33m${t}\x1b[0m`);
  return out;
}

if (opts.json) {
  process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
  process.exit(0);
}

if (!hits.length) {
  process.stdout.write(`没有命中：${terms.join(opts.any ? " 或 " : " 且 ")}\n`);
  process.exit(1);
}

process.stdout.write(`命中 ${hits.length} 条（最多 ${opts.limit}）\n\n`);
for (const h of hits) {
  process.stdout.write(
    `${h.time}  ${KIND_LABEL[h.kind] || h.type}  ${h.title}\n` +
      `  ${h.directory}  ${h.session}\n` +
      `  ${highlight(h.snippet, h.matched, opts.color)}\n\n`,
  );
}