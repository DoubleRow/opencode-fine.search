/**
 * 搜索浮层的纯逻辑：类型筛选、选中项移动。
 *
 * 不依赖 DOM / Solid，便于 node:test 直接引用。
 */

import type { SearchOutputItem } from "./rpc.ts";

export type OverlayFilter = "all" | "assistant" | "tool" | "reasoning" | "user";

export interface FilterOption {
  id: OverlayFilter;
  label: string;
}

export const FILTERS: readonly FilterOption[] = [
  { id: "all", label: "全部" },
  { id: "assistant", label: "回答" },
  { id: "tool", label: "工具" },
  { id: "reasoning", label: "思考" },
  { id: "user", label: "提问" },
];

export function filterLabel(filter: OverlayFilter): string {
  return FILTERS.find((option) => option.id === filter)?.label ?? "全部";
}

/** 按类型筛选；「全部」返回副本，避免调用方改到原始结果。 */
export function filterItems(
  items: readonly SearchOutputItem[],
  filter: OverlayFilter,
): SearchOutputItem[] {
  if (filter === "all") return items.slice();
  return items.filter((item) => item.kind === filter);
}

/** 把索引夹到 [0, count-1]；空列表返回 0。 */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  const value = Math.trunc(Number(index) || 0);
  if (value < 0) return 0;
  if (value >= count) return count - 1;
  return value;
}

/** 在 [0, count-1] 上循环移动；空列表返回 0。 */
export function stepIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  const step = Math.trunc(Number(delta) || 0);
  const current = ((Math.trunc(Number(index) || 0) % count) + count) % count;
  return (((current + step) % count) + count) % count;
}