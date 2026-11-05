/**
 * 会话流水的纯逻辑：按消息分组、分页合并、显示截断与角色标签。
 *
 * 不依赖 DOM / Solid，node:test 可直接引用。
 */

import type { StreamItem } from "./rpc.ts";

/** 单条默认显示上限（展开后再按需取全文）。 */
export const DISPLAY_CHARS = 2000;

export interface StreamBlock {
  messageId: string;
  items: StreamItem[];
}

/** 相邻且同一 messageId 的片段合成一个消息块。 */
export function groupByMessage(items: readonly StreamItem[]): StreamBlock[] {
  const blocks: StreamBlock[] = [];
  for (const item of items) {
    const last = blocks[blocks.length - 1];
    if (last && last.messageId === item.messageId) last.items.push(item);
    else blocks.push({ messageId: item.messageId, items: [item] });
  }
  return blocks;
}

/** 合并两页：按 segmentId 去重并升序，翻页重叠时不会重复。 */
export function mergeItems(
  previous: readonly StreamItem[],
  incoming: readonly StreamItem[],
): StreamItem[] {
  const byId = new Map<number, StreamItem>();
  for (const item of previous) byId.set(item.segmentId, item);
  for (const item of incoming) byId.set(item.segmentId, item);
  return [...byId.values()].sort((a, b) => a.segmentId - b.segmentId);
}

/** 消息块的主角色：用户 > 助手 > 第一条。 */
export function blockKind(block: StreamBlock): string {
  const primary =
    block.items.find((item) => item.kind === "user") ??
    block.items.find((item) => item.kind === "assistant") ??
    block.items[0];
  return primary?.kind ?? "assistant";
}

const ROLE_LABELS: Record<string, string> = {
  user: "用户",
  assistant: "助手",
  reasoning: "思考",
  tool: "工具",
  system: "系统",
  synthetic: "合成",
  compaction: "摘要",
};

export function roleLabel(kind: string): string {
  return ROLE_LABELS[kind] || kind || "消息";
}

/** 显示用截断；返回是否被截断，方便渲染「展开」按钮。 */
export function previewText(
  text: string,
  limit = DISPLAY_CHARS,
): { text: string; clipped: boolean } {
  const value = String(text ?? "");
  const size = Math.max(1, Number(limit) || DISPLAY_CHARS);
  if (value.length <= size) return { text: value, clipped: false };
  return { text: value.slice(0, size), clipped: true };
}

/** 下一个分页偏移：向上翻页时不许小于 0。 */
export function nextOffset(offset: number, length: number, direction: "before" | "after") {
  const start = Math.max(0, Number(offset) || 0);
  const count = Math.max(0, Number(length) || 0);
  return direction === "before" ? Math.max(0, start - count) : start + count;
}