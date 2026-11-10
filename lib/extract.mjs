/**
 * 消息 → 可检索片段。
 *
 * 索引规则集中在这里：
 * - 入库：user.text、assistant.text、reasoning、tool.input、tool.output、
 *   system、synthetic、compaction.summary。
 * - 排除：data: URI、write.content、edit.oldString/newString、snapshot/diff、
 *   模型元数据。
 */

/** 递归收集工具参数/结果时要跳过的字段名。 */
const SKIP_KEYS = new Set([
  "content",
  "oldString",
  "newString",
  "patch",
  "diff",
  "snapshot",
  "rawFinish",
  "metadata",
  "tokens",
  "model",
  "time",
  "status",
  "id",
  "callID",
  "callId",
  "base64",
]);

/**
 * 只匹配足够长的 base64 data URI。短字符串里的 `data:` 不处理，
 * 避免误伤普通正文。
 */
const DATA_URI_RE =
  /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+)*;base64,[A-Za-z0-9+/=\r\n]{64,}/gi;

/** 字符串本身是不是一个 data URI（图片/附件）。 */
export function isDataUri(value) {
  return typeof value === "string" && /^\s*data:/i.test(value);
}

/** 把正文中内嵌的 data URI 替换成占位符。 */
export function scrubDataUris(value) {
  if (typeof value !== "string") return value;
  if (!value.includes("data:")) return value;
  return value.replace(DATA_URI_RE, "[data URI 已省略]");
}

/** 清洗单个字符串：去 NUL、剔除 data URI、去首尾空白。 */
function clean(value) {
  if (typeof value !== "string") return "";
  if (isDataUri(value)) return "";
  const text = scrubDataUris(value).replaceAll("\u0000", "").trim();
  return text;
}

/**
 * 递归收集对象里的字符串。
 *
 * @param {unknown} value
 * @param {string[]} out
 * @param {number} depth
 */
function collectStrings(value, out, depth = 0) {
  if (value == null || depth > 6) return;
  if (typeof value === "string") {
    const text = clean(value);
    if (text) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (SKIP_KEYS.has(key)) continue;
      collectStrings(item, out, depth + 1);
    }
  }
}

/** 工具结果里的 content 数组：只取文本与本地路径，data: URI 直接跳过。 */
function collectToolContent(value, out, depth = 0) {
  if (value == null || depth > 5) return;
  if (typeof value === "string") {
    const text = clean(value);
    if (text) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectToolContent(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  if (itemType(value) === "text" && typeof value.text === "string") {
    const text = clean(value.text);
    if (text) out.push(text);
    return;
  }
  if (itemType(value) === "file" || itemType(value) === "image") {
    if (typeof value.path === "string") {
      const text = clean(value.path);
      if (text) out.push(text);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (SKIP_KEYS.has(key)) continue;
    collectToolContent(item, out, depth + 1);
  }
}

function itemType(value) {
  return typeof value?.type === "string" ? value.type : "";
}

/** 工具片段：参数 + 结果 + 错误，排除文件正文与 diff。 */
function extractToolText(part) {
  const lines = [];
  const state = part?.state && typeof part.state === "object" ? part.state : {};

  collectStrings(state.input, lines);
  collectToolContent(state.content, lines);

  const error = state.error;
  if (typeof error === "string") {
    const text = clean(error);
    if (text) lines.push(text);
  } else if (error && typeof error === "object" && typeof error.message === "string") {
    const text = clean(error.message);
    if (text) lines.push(text);
  }

  return lines.join("\n\n").trim();
}

/**
 * 把一条 session_message 拆成可检索片段。
 *
 * @param {{ id?: string, sessionId?: string, type?: string, timeCreated?: number, data: string }} message
 * @returns {{ kind: string, text: string }[]}
 */
export function extractSegments(message) {
  const type = typeof message?.type === "string" ? message.type : "unknown";
  const raw = typeof message?.data === "string" ? message.data : "";

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const text = clean(raw);
    return text ? [{ kind: type, text }] : [];
  }

  if (parsed == null || typeof parsed !== "object") {
    const text = clean(String(parsed ?? ""));
    return text ? [{ kind: type, text }] : [];
  }

  /** @type {{ kind: string, text: string }[]} */
  const segments = [];
  const push = (kind, value) => {
    const text = clean(value);
    if (text) segments.push({ kind, text });
  };

  if (type === "user") {
    push("user", parsed.text);
    // 某些版本把输入放在 metadata.displayText。
    const display = parsed.metadata?.displayText;
    if (typeof display === "string" && display !== parsed.text) push("user", display);
    return segments;
  }

  if (type === "assistant") {
    if (Array.isArray(parsed.content)) {
      for (const part of parsed.content) {
        if (!part || typeof part !== "object") continue;
        if (itemType(part) === "text") push("assistant", part.text);
        else if (itemType(part) === "reasoning") push("reasoning", part.text);
        else if (itemType(part) === "tool") {
          const text = extractToolText(part);
          if (text) segments.push({ kind: "tool", text });
        }
      }
    }
    // snapshot / finish / tokens / model / rawFinish 一律不入库。
    return segments;
  }

  if (type === "compaction") {
    push("compaction", parsed.summary);
    return segments;
  }

  if (type === "system" || type === "synthetic") {
    push(type, parsed.text);
    return segments;
  }

  // 其它类型只在带 text 时入库（例如旧版消息）。
  push(type, parsed.text);
  return segments;
}

/**
 * 增量同步用的消息指纹：时间戳或长度变化即视为需要重建。
 *
 * 注意：内容等长的改写若连 time_updated 都不变，这里检测不到。改用内容 hash
 * 需要在每次同步时读取全部 message.data（本机实测数百 MB），代价远大于收益。
 */
export function fingerprintOf(row) {
  return `${row.time_updated ?? 0}:${row.data_length ?? 0}`;
}