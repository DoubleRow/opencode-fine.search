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
export interface CardBoxInput {
  viewportWidth: number;
  /** 右侧详情栏宽度；0 表示没开。 */
  panelWidth: number;
  /** 时间线左边界（左侧会话栏之后）。 */
  contentLeft: number;
  gap?: number;
  maxWidth?: number;
}

/**
 * 浮层卡片的落位：在「时间线左边界 → 详情栏左边界」之间居中，
 * 宽度不超过 720px，也不越过两侧。
 */
export function cardBox(input: CardBoxInput): { left: number; width: number } {
  const viewport = Math.max(320, Math.round(input.viewportWidth) || 0);
  const panel = Math.max(0, Math.min(Math.round(input.panelWidth) || 0, viewport - 240));
  const contentLeft = Math.max(0, Math.min(Math.round(input.contentLeft) || 0, viewport - 240));
  const gap = Math.max(0, Number(input.gap) || 16);
  const maxWidth = Math.max(240, Number(input.maxWidth) || 720);

  const available = Math.max(160, viewport - panel - contentLeft);
  const width = Math.max(200, Math.min(maxWidth, available - gap * 2, viewport - 16));
  const centered = Math.round(contentLeft + (available - width) / 2);
  const left = Math.max(8, Math.min(centered, viewport - width - 8));
  return { left, width };
}

/**
 * 卡片位移量。
 *
 * 卡片用 `left: 50%` + `translate3d(calc(-50% + offset))` 定位，
 * 左边缘落点 = 视口中心 + offset - 卡片半宽；这里反解出 offset，
 * 使左边缘正好等于 cardBox 给出的 left。
 */
export function cardOffset(left: number, width: number, viewportWidth: number): number {
  return left - (viewportWidth - width) / 2;
}

export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  const value = Math.trunc(Number(index) || 0);
  if (value < 0) return 0;
  if (value >= count) return count - 1;
  return value;
}

/** 在 [0, count-1] 上移动，到边界停住；空列表返回 0。 */
export function stepIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  const step = Math.trunc(Number(delta) || 0);
  const current = Math.max(0, Math.min(Math.trunc(Number(index) || 0), count - 1));
  return Math.max(0, Math.min(current + step, count - 1));
}