/**
 * 详情面板的纯逻辑：命中分组、自动打开窗口、折叠行数、标签。
 * 不依赖 DOM / Solid，便于测试。
 */

import type { SearchOutputItem, SummarySource } from "./rpc.ts";

export interface PendingSelection {
  query: string;
  hits: SearchOutputItem[];
  at: number;
}

export interface DetailSelection extends PendingSelection {
  index: number;
}

export function groupHitsBySession(items: SearchOutputItem[]): Map<string, SearchOutputItem[]> {
  const groups = new Map<string, SearchOutputItem[]>();
  for (const item of items) {
    const list = groups.get(item.sessionId);
    if (list) list.push(item);
    else groups.set(item.sessionId, [item]);
  }
  return groups;
}

/** 5 秒内、当前会话命中时返回 pending；过期/不存在返回 undefined。 */
export function pendingFor(
  pending: Map<string, PendingSelection>,
  sessionId: string,
  now = Date.now(),
  windowMs = 5000,
): PendingSelection | undefined {
  const entry = pending.get(sessionId);
  if (!entry) return undefined;
  if (now - entry.at > windowMs) return undefined;
  return entry;
}

/** 查询词拆成高亮词表；空查询返回空数组。 */
export function termsOf(query: string | undefined): string[] {
  return String(query ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function collapseLines(text: string, expanded: boolean, limit = 20) {
  const lines = String(text ?? "").split("\n");
  const total = lines.length;
  const visible = expanded ? lines : lines.slice(0, limit);
  return {
    total,
    visible,
    canExpand: total > limit,
    hidden: Math.max(0, total - limit),
  };
}

const KIND_LABELS: Record<string, string> = {
  user: "用户输入",
  assistant: "助手回复",
  reasoning: "思考过程",
  tool: "工具输出",
  system: "系统注入",
  synthetic: "合成消息",
  compaction: "压缩摘要",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] || kind || "消息";
}

export function sourceLabel(source: SummarySource | string): string {
  if (source === "llm") return "LLM";
  if (source === "memory") return "记忆";
  return "自动";
}

export function formatWhen(ts: number): string {
  if (!ts) return "";
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}