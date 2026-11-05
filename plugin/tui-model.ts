/**
 * TUI 搜索对话框的纯逻辑：常量、错误文案、请求代次、结果行、导航。
 *
 * 不依赖 DOM / Solid / OpenTUI，node:test 可直接引用（type-stripping）。
 */

import type { SearchOutputItem } from "./rpc.ts";
import { FILTERS, type OverlayFilter } from "./overlay-model.ts";
import { roleLabel } from "./stream-model.ts";

/** 输入防抖：低于 GUI 侧感知阈值，避免每键一发 RPC。 */
export const DEBOUNCE_MS = 120;

/** 单次搜索返回条数（服务端上限内，与 GUI 浮层一致）。 */
export const SEARCH_LIMIT = 100;

/** 预览原文固定行数（与 GUI 详情栏口径一致）。 */
export const PREVIEW_LINES = 20;

/** 只读回放分页大小（与 stream RPC 默认一致）。 */
export const STREAM_PAGE = 40;

/** RPC 调用代次：每条异步通道一个 lane，旧请求按编号丢弃。 */
export interface TokenLane {
  /** 领取本次请求的编号（会让此前领取的编号失效）。 */
  begin(): number;
  /** 该编号是否仍是最新请求。 */
  isCurrent(id: number): boolean;
}

export function tokenLane(): TokenLane {
  let token = 0;
  return {
    begin() {
      token += 1;
      return token;
    },
    isCurrent(id: number) {
      return id === token;
    },
  };
}

/** 把未知异常压成一行中文可展示的文本。 */
export function errorText(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || error.name;
  const record = error as Record<string, unknown>;
  const message = record.message ?? record.reason;
  if (typeof message === "string" && message) return message;
  return String(error);
}

/** 单行列表的默认可视宽度（对话框左栏），超出截断加省略号。 */
export const LINE_WIDTH = 64;

/** 列表区域可滚动的行数。 */
export const LIST_WINDOW = 14;

/** PgUp/PgDn 一次跳过的命中条数。 */
export const PAGE_HITS = 10;

/** 压平空白便于单行展示；两端去空格。 */
export function flatten(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** 按显示宽度截断（按字符数，CJK 会略偏宽，可接受）。 */
export function fitText(value: string, width = LINE_WIDTH): string {
  const limit = Math.max(1, Math.trunc(width) || LINE_WIDTH);
  const text = flatten(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

const DAY_MS = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 分组头日期：今天 / 昨天 / MM-DD / YYYY-MM-DD。 */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const value = Number(ts) || 0;
  const days = Math.round((startOfDay(now) - startOfDay(value)) / DAY_MS);
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  if (days > 1 && days < 365 && d.getFullYear() === new Date(now).getFullYear()) {
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeLabel(ts: number): string {
  const d = new Date(Number(ts) || 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 目录 → 项目短名（末段）。 */
export function projectName(directory: string): string {
  const value = flatten(directory).replace(/[\\/]+$/, "");
  if (!value) return "未知项目";
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

/** 按 sessionId 分组，保持搜索结果的相对顺序（首现次序）。 */
export interface ResultGroup {
  sessionId: string;
  title: string;
  directory: string;
  items: SearchOutputItem[];
}

export function groupBySession(items: readonly SearchOutputItem[]): ResultGroup[] {
  const groups: ResultGroup[] = [];
  const byId = new Map<string, ResultGroup>();
  for (const item of items) {
    let group = byId.get(item.sessionId);
    if (!group) {
      group = {
        sessionId: item.sessionId,
        title: item.title,
        directory: item.directory,
        items: [],
      };
      byId.set(item.sessionId, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** 列表行：分组头不可选中，命中行携带原条目。 */
export type TuiRow =
  | { readonly type: "header"; readonly text: string }
  | { readonly type: "hit"; readonly text: string; readonly item: SearchOutputItem };

export function buildRows(
  items: readonly SearchOutputItem[],
  now: number = Date.now(),
): TuiRow[] {
  const rows: TuiRow[] = [];
  for (const group of groupBySession(items)) {
    const first = group.items[0];
    const day = first ? dayLabel(first.ts, now) : "";
    rows.push({
      type: "header",
      text: `── ${day} · ${projectName(group.directory)} ──`,
    });
    for (const item of group.items) {
      rows.push({
        type: "hit",
        item,
        text: fitText(
          `${timeLabel(item.ts)} ${roleLabel(item.kind)} · ${flatten(item.title)} · ${flatten(item.snippet)}`,
        ),
      });
    }
  }
  return rows;
}

/**
 * 在命中行之间步进 delta 条（delta>1 用于 PgUp/PgDn）。
 * 当前不在命中行时：正向进第一条，逆向进最后一条；无命中返回 -1。
 */
export function stepHits(rows: readonly TuiRow[], index: number, delta: number): number {
  const hits: number[] = [];
  rows.forEach((row, i) => {
    if (row.type === "hit") hits.push(i);
  });
  if (hits.length === 0) return -1;
  const step = Math.trunc(delta) || 0;
  let pos = hits.indexOf(index);
  if (pos === -1) pos = step >= 0 ? -1 : hits.length;
  const next = ((pos + step) % hits.length + hits.length) % hits.length;
  return hits[next];
}

/**
 * 列表滚动起点：保证选中行可见，尽量少动。
 * prev 为当前起点；返回 [start, start+visible) 的 start。
 */
export function scrollStart(
  prev: number,
  index: number,
  count: number,
  visible: number,
): number {
  if (count <= 0 || index < 0) return 0;
  const win = Math.max(1, Math.trunc(visible) || LIST_WINDOW);
  const maxStart = Math.max(0, count - win);
  const current = Math.max(0, Math.min(Math.trunc(prev) || 0, maxStart));
  if (index < current) return Math.max(0, index - 1);
  if (index >= current + win) return Math.min(index - win + 1, maxStart);
  return current;
}

/** 循环切换筛选（与 GUI 浮层同一套 FILTERS 顺序）。 */
export function nextFilter(current: OverlayFilter): OverlayFilter {
  const ids = FILTERS.map((option) => option.id);
  const at = ids.indexOf(current);
  return ids[(at + 1) % ids.length] ?? "all";
}
