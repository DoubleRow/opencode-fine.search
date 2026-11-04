/**
 * 会话摘要：确定性自动摘要 + 记忆摘要解析 + 来源优先级。
 *
 * 纯函数集中在这里，worker / 脚本 / 测试共用；不读写数据库，也不发网络请求。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 目录的 basename，兼容 Unix 与 Windows 分隔符。 */
export function projectName(directory) {
  const value = String(directory ?? "").trim().replace(/[\\/]+$/, "");
  if (!value) return "(未知项目)";
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] || "(未知项目)";
}

/** 压平空白后截断，保证长度上限。 */
export function clip(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!max || value.length <= max) return value;
  return value.slice(0, max);
}

export function splitSentences(text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!value) return [];
  return value
    .split(/(?<=[。！？.!?])\s*/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function firstSentences(text, count = 2, max = 120) {
  return clip(splitSentences(text).slice(0, count).join(""), max);
}

export function lastSentences(text, count = 2, max = 100) {
  const sentences = splitSentences(text);
  return clip(sentences.slice(-count).join(""), max);
}

/** 从 opencode-mem 的 `## Outcome` 段取前 2 句。 */
export function parseMemoryOutcome(content, max = 120) {
  const value = String(content ?? "");
  const match = /(?:^|\n)##\s*Outcome\s*\n([\s\S]*?)(?=\n##\s+|$)/i.exec(value);
  if (!match) return "";
  return firstSentences(match[1], 2, max);
}

/**
 * 确定性摘要：任何会话都能算出，保证 100% 覆盖。
 *
 * @param {{ title?: string, directory?: string, firstUser?: string, lastAssistant?: string, lastTool?: string }} input
 */
export function autoSummary(input = {}) {
  const project = projectName(input.directory);
  const doing = clip(input.title || input.firstUser || "", 80) || "(无标题会话)";
  const solved = input.lastAssistant
    ? lastSentences(input.lastAssistant, 2, 100) || "（暂无助手正文）"
    : input.lastTool
      ? "工具执行完成"
      : "（暂无助手回复）";
  return { project, doing, solved };
}

/**
 * 摘要来源优先级：LLM > 记忆 > 自动。
 *
 * @param {{
 *   stored?: { source: string, project: string, doing: string, solved: string, updatedAt?: number } | null,
 *   memory?: { solved: string } | null,
 *   auto: { project: string, doing: string, solved: string },
 *   sessionUpdated?: number,
 * }} input
 */
export function chooseSummary(input) {
  const { stored, memory, auto } = input;

  if (stored?.source === "llm") {
    return {
      source: "llm",
      project: stored.project || auto.project,
      doing: stored.doing || auto.doing,
      solved: stored.solved || auto.solved,
    };
  }

  if (memory?.solved) {
    return {
      source: "memory",
      project: auto.project,
      doing: stored?.source === "auto" && stored.doing ? stored.doing : auto.doing,
      solved: memory.solved,
    };
  }

  const sessionUpdated = Number(input.sessionUpdated) || 0;
  if (
    stored?.source === "auto" &&
    Number(stored.updatedAt) >= sessionUpdated &&
    stored.project &&
    stored.doing &&
    stored.solved
  ) {
    return {
      source: "auto",
      project: stored.project,
      doing: stored.doing,
      solved: stored.solved,
    };
  }

  return { source: "auto", ...auto };
}

const MEMORY_URL = (process.env.OC_SEARCH_MEMORY_URL || "http://127.0.0.1:4747").replace(
  /\/+$/,
  "",
);
const MEMORY_TOKEN_PATH =
  process.env.OC_SEARCH_MEMORY_TOKEN || join(homedir(), ".opencode-mem", ".auth-token");

function memoryMeta(item) {
  const metadata = item?.metadata;
  if (!metadata) return {};
  if (typeof metadata === "string") {
    try {
      return JSON.parse(metadata);
    } catch {
      return {};
    }
  }
  return metadata;
}

/**
 * 只读拉取 opencode-mem 的记忆摘要，返回 Map<sessionID, { solved }>。
 *
 * token 只在本进程内使用；连接失败、401、无 token 都返回空 Map，由调用方降级到自动摘要。
 */
export async function fetchMemorySummaries(options = {}) {
  let token = "";
  try {
    token = readFileSync(MEMORY_TOKEN_PATH, "utf8").trim();
  } catch {
    return new Map();
  }
  if (!token) return new Map();

  const pageSize = Math.max(1, Number(options.pageSize) || 100);
  const maxPages = Math.max(1, Number(options.maxPages) || 20);
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 1500);
  const summaries = new Map();

  for (let page = 1; page <= maxPages; page += 1) {
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout;
      const response = await fetch(
        `${MEMORY_URL}/api/memories?page=${page}&pageSize=${pageSize}&includePrompts=false`,
        { headers: { "x-opencode-mem-token": token }, signal },
      );
      if (!response.ok) return summaries;

      const payload = await response.json();
      if (!payload?.success) return summaries;

      for (const item of payload.data?.items ?? []) {
        if (item?.type !== "memory") continue;
        const meta = memoryMeta(item);
        const sessionId = meta.sessionID;
        if (typeof sessionId !== "string" || !sessionId) continue;

        const solved = parseMemoryOutcome(item.content);
        if (!solved) continue;

        const createdAt = Number(item.createdAt) || 0;
        const previous = summaries.get(sessionId);
        if (!previous || createdAt >= previous.createdAt) {
          summaries.set(sessionId, { solved, createdAt });
        }
      }

      const totalPages = Number(payload.data?.totalPages) || 1;
      if (page >= totalPages) break;
    } catch {
      // 4747 未启动、token 失效或超时：直接降级。
      return summaries;
    }
  }

  return summaries;
}