/**
 * TUI 搜索对话框的纯逻辑：常量、错误文案、请求代次、结果行、导航、预览。
 *
 * 不依赖 DOM / Solid / OpenTUI，node:test 可直接引用（type-stripping）。
 */

import type { SearchOutputItem, StreamItem } from "./rpc.ts";
import { FILTERS, type OverlayFilter } from "./overlay-model.ts";
import { collapseLines } from "./panel-model.ts";
import { DISPLAY_CHARS, previewText, roleLabel } from "./stream-model.ts";

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

/** 单行列表的默认可视宽度，超出截断加省略号。 */
export const LINE_WIDTH = 64;

/** 列表区域默认可见行数（纯函数缺省值；页面按实测高度覆盖）。 */
export const LIST_WINDOW = 10;

/**
 * 页面布局：把终端可用宽高换算成两栏的数值尺寸。
 *
 * 页面路由实测可用区 = 终端整屏（160×45 时 root=160×45），因此直接按整屏算；
 * `< 96` 列为窄屏，退化成单栏（列表/详情由 Tab 切换）。
 */
export interface PageLayout {
  readonly wide: boolean;
  readonly width: number;
  readonly height: number;
  /** 左栏宽度（含缩进）。 */
  readonly left: number;
  /** 右栏宽度。 */
  readonly right: number;
  /** 正文可用高度（已扣掉页头、查询行、底栏）。 */
  readonly bodyHeight: number;
  /** 左栏能放下的行数。 */
  readonly listRows: number;
  /** 右栏预览最多渲染的原文行数。 */
  readonly previewLines: number;
  /** 右栏回放窗口行数。 */
  readonly replayRows: number;
  /** 右栏正文换行宽度。 */
  readonly textWidth: number;
  /** 右栏回放换行宽度：比正文再留 1 格余量，避免行尾被渲染层裁掉。 */
  readonly replayWidth: number;
  /** 左栏每行的可用宽度（扣掉光标与缩进）。 */
  readonly listTextWidth: number;
}

const PAGE_CHROME = 5; // 标题 1 + 查询 1 + 筛选 1 + 状态 1 + 底栏 1
const RIGHT_CHROME = 10; // 详情头 1 + 元信息 3 + 摘要基准 4 + 分区 1 + 底部 1

export function pageLayout(width: number, height: number): PageLayout {
  const w = Math.max(40, Math.trunc(width) || 80);
  const h = Math.max(12, Math.trunc(height) || 30);
  const wide = w >= 96;
  const left = wide ? Math.max(32, Math.min(64, Math.round(w * 0.36))) : w;
  const right = wide ? Math.max(24, w - left - 1) : w;
  const bodyHeight = Math.max(6, h - PAGE_CHROME);
  return {
    wide,
    width: w,
    height: h,
    left,
    right,
    bodyHeight,
    listRows: Math.max(4, bodyHeight - 2), // 左栏上下边框各占 1 行
    previewLines: Math.max(4, bodyHeight - RIGHT_CHROME),
    replayRows: Math.max(4, bodyHeight - 4),
    textWidth: Math.max(20, right - 2),
    // 右栏实际可用宽度是 right - 1（左边距 1 格）；再让出 1 格，
    // 抵消宽字符/emoji 估算偏差，避免行尾被裁。
    replayWidth: Math.max(19, right - 3),
    listTextWidth: Math.max(16, left - 4),
  };
}

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

/** 按显示宽度（CJK 记 2 格）截断，给固定列宽的终端布局用；fitText 按字符数会溢出。 */
export function clipDisplay(value: string, width: number): string {
  const limit = Math.max(1, Math.trunc(width) || 1);
  const text = flatten(value);
  if (displayWidth(text) <= limit) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (used + w > limit - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
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

export function timeLabel(ts: number): string {
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
/**
 * 命中间导航：跳过分组头，到首/尾停住（不环回）。
 * index 不在命中行上时：向前取第一条，向后取最后一条。
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
  const next = Math.max(0, Math.min(pos + step, hits.length - 1));
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
  // 下移越界时也留一行余量（与向上分支的 index - 1 对称），
  // 否则选中行贴着列表底边框，看不出「还有下一行」。
  if (index >= current + win) return Math.min(index - win + 2, maxStart);
  return current;
}

/** 循环切换筛选（与 GUI 浮层同一套 FILTERS 顺序）。 */
export function nextFilter(current: OverlayFilter): OverlayFilter {
  const ids = FILTERS.map((option) => option.id);
  const at = ids.indexOf(current);
  return ids[(at + 1) % ids.length] ?? "all";
}

/** 摘要来源徽标（与 GUI SummaryBlock 口径一致）。 */
export function sourceLabel(source: string): string {
  if (source === "llm") return "LLM";
  if (source === "memory") return "记忆";
  if (source === "auto") return "自动";
  return source || "自动";
}

/**
 * 预览列硬包宽度（字符当量）。终端比对话框实际宽度保守取值，
 * 溢出由渲染层裁剪。
 */
export const PREVIEW_WIDTH = 70;

/** 终端显示宽度估算：CJK 全角按 2，零宽组合符按 0，其余按 1。 */
export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    width += charWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

/**
 * 单字符占位宽。宁可高估也不要低估：低估会让 `wrapLine` 算出刚好合适的换行，
 * 实际渲染超宽后被终端裁掉行尾（emoji 最典型，实际 2 格却按 1 计）。
 */
function charWidth(code: number): number {
  // 零宽：组合用附加符、变体选择符、零宽连接符等，不占格。
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    code === 0xfeff
  ) {
    return 0;
  }
  const full =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f000 && code <= 0x1faff) || // emoji、图形符号补充区
    (code >= 0x2600 && code <= 0x27bf) || // 杂项/装饰符号，多为 emoji 呈现
    (code >= 0x2b00 && code <= 0x2bff) || // 箭头与图形符号
    (code >= 0x20000 && code <= 0x2fffd);
  return full ? 2 : 1;
}

/** 按显示宽度硬包一行；空行返回 [""]，保证行数可预算。 */
export function wrapLine(line: string, width: number = PREVIEW_WIDTH): string[] {
  const limit = Math.max(8, Math.trunc(width) || PREVIEW_WIDTH);
  const value = String(line ?? "");
  if (!value) return [""];
  const out: string[] = [];
  let chunk = "";
  let used = 0;
  for (const char of value) {
    const w = displayWidth(char);
    if (used + w > limit && chunk) {
      out.push(chunk);
      chunk = "";
      used = 0;
    }
    chunk += char;
    used += w;
  }
  if (chunk) out.push(chunk);
  return out;
}

export interface HighlightPart {
  text: string;
  hit: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 高亮切分：与 GUI detail-parts 的 highlightParts 同一算法
 * （去重、长词优先、大小写不敏感），TUI 侧独立实现避免牵入 Web JSX。
 */
export function highlightParts(text: string, terms: readonly string[]): HighlightPart[] {
  const source = String(text ?? "");
  const words = [...new Set(terms.map((term) => term.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (!words.length) return [{ text: source, hit: false }];

  const pattern = new RegExp(words.map(escapeRegExp).join("|"), "gi");
  const parts: HighlightPart[] = [];
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: source.slice(last, at), hit: false });
    parts.push({ text: match[0], hit: true });
    last = at + match[0].length;
  }
  if (last < source.length) parts.push({ text: source.slice(last), hit: false });
  return parts.length ? parts : [{ text: source, hit: false }];
}

/** 把任意值裁成最多 max 行（按显示宽度硬包），超出补一行「…」。 */
export function clipLines(value: string, width: number, max: number): string[] {
  const limit = Math.max(1, Math.trunc(max) || 1);
  const lines: string[] = [];
  for (const source of String(value ?? "").split("\n")) {
    lines.push(...wrapLine(source, width));
  }
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), "…"];
}

/**
 * 预览视图：与 GUI 相同口径——只显示前 limit 个源行（不锚定命中位置），
 * 每行按宽度硬包；有隐藏行时追加一行提示。
 */
export function previewView(
  text: string,
  width: number = PREVIEW_WIDTH,
  limit: number = PREVIEW_LINES,
): { lines: string[]; hidden: number } {
  const collapsed = collapseLines(text, false, limit);
  const lines: string[] = [];
  for (const line of collapsed.visible) lines.push(...wrapLine(line, width));
  const hidden = collapsed.hidden;
  if (hidden > 0) lines.push(`… 另有 ${hidden} 行（Tab 切到只读回放）`);
  return { lines, hidden };
}

/** 只读回放的显示窗口行数（右栏，独立于结果列表窗口）。 */
export const REPLAY_WINDOW = 24;

export interface ReplayOptions {
  anchorSegmentId: number;
  /** 思考段是否展开（Ctrl+T），默认收起，与 GUI 口径一致。 */
  showReasoning: boolean;
  /** 命中条是否已用 read 取全文展开（Ctrl+J）。 */
  anchorExpanded: boolean;
  /** read 返回的命中条全文；未加载时为 null。 */
  anchorFullText: string | null;
  width?: number;
}

export interface ReplayLine {
  text: string;
  tone: "head" | "body" | "note" | "collapsed";
  /** 该行属于哪个片段；提示行也携带，便于回跳定位。 */
  segmentId: number;
  /** 是否为当前命中条的行。 */
  hit: boolean;
}

/**
 * 回放行渲染数据：条头、正文（2000 字显示截断）、思考收起行、剩余提示。
 * 命中条在 anchorExpanded 后用全文（read RPC）替换流内的 4000 字截断。
 */
export function replayLines(items: readonly StreamItem[], opts: ReplayOptions): ReplayLine[] {
  const width = opts.width ?? PREVIEW_WIDTH;
  const lines: ReplayLine[] = [];
  for (const item of items) {
    const isHit = item.segmentId === opts.anchorSegmentId;
    lines.push({
      segmentId: item.segmentId,
      hit: isHit,
      tone: "head",
      text: `${timeLabel(item.ts)} ${roleLabel(item.kind)} · 片段 ${item.segmentId}${isHit ? " ◀ 命中" : ""}`,
    });

    if (item.kind === "reasoning" && !opts.showReasoning) {
      lines.push({
        segmentId: item.segmentId,
        hit: isHit,
        tone: "collapsed",
        text: `思考过程已收起 · 共 ${item.length} 字（Ctrl+T 展开）`,
      });
      continue;
    }

    const useFull = isHit && opts.anchorExpanded && typeof opts.anchorFullText === "string";
    const shown = useFull ? String(opts.anchorFullText) : previewText(item.text, DISPLAY_CHARS).text;
    for (const source of shown.split("\n")) {
      for (const chunk of wrapLine(source, width)) {
        lines.push({ segmentId: item.segmentId, hit: isHit, tone: "body", text: chunk });
      }
    }

    const remaining = Math.max(0, (Number(item.length) || 0) - shown.length);
    if (remaining > 0) {
      lines.push({
        segmentId: item.segmentId,
        hit: isHit,
        tone: "note",
        text: isHit && !opts.anchorExpanded
          ? `… 本条共 ${item.length} 字（Ctrl+J 展开全文）`
          : `… 本条共 ${item.length} 字（打开会话看全文）`,
      });
    }
  }
  return lines;
}

/** 找到某片段首行的下标；用于「加载更早」后保持视口稳定。找不到返回 -1。 */
export function firstLineIndexFor(lines: readonly ReplayLine[], segmentId: number): number {
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].segmentId === segmentId) return i;
  }
  return -1;
}

/** 滚动位置步进并夹在 [0, count-1]。 */
export function moveScroll(prev: number, delta: number, count: number): number {
  const max = Math.max(0, count - 1);
  const current = Math.max(0, Math.trunc(prev) || 0);
  const step = Math.trunc(delta) || 0;
  return Math.max(0, Math.min(current + step, max));
}

/** 打开会话的两条通路：优先标签页聚焦，退回整页路由跳转。 */
export type OpenWay = "tabs" | "router";

/**
 * 打开会话的尝试顺序（纯函数，便于单测锁住回退语义）：
 * 标签页模式启用时先走 tabs，失败或不可用再走 router；未启用直接跳页。
 */
export function openPlan(tabsEnabled: boolean): OpenWay[] {
  return tabsEnabled ? ["tabs", "router"] : ["router"];
}
