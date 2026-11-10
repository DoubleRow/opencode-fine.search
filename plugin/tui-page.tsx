/** @jsxImportSource @opentui/solid */
/**
 * 全文检索 TUI 页面。
 *
 * 入口是独立路由页（`ui.router.register`），占满主内容区，随终端宽高实时重排：
 * 左栏检索结果，右栏照搬 GUI 详情侧栏（项目/会话/标签/摘要/原文/回放）。
 *
 * 纯逻辑（布局、行、回放、筛选）仍在 tui-model.ts / panel-model.ts，
 * 本文件只负责状态与呈现。
 */

import type { Context, Route } from "@opencode/plugin/tui/context";
import type { RGBA } from "@opentui/core";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";

import {
  SearchRpc,
  type ReadOutput,
  type SearchOutputItem,
  type StatusOutput,
  type StreamItem,
  type StreamOutput,
  type SummaryOutput,
} from "./rpc.js";
import { FILTERS, filterItems, filterLabel, type OverlayFilter } from "./overlay-model.js";
import { formatWhen, kindLabel, termsOf } from "./panel-model.js";
import { mergeItems, nextOffset } from "./stream-model.js";
import {
  DEBOUNCE_MS,
  PAGE_HITS,
  SEARCH_LIMIT,
  STREAM_PAGE,
  buildRows,
  clipDisplay,
  clipLines,
  displayWidth,
  errorText,
  firstLineIndexFor,
  highlightParts,
  moveScroll,
  nextFilter,
  pageLayout,
  previewView,
  projectName,
  replayLines,
  scrollStart,
  sourceLabel,
  stepHits,
  tokenLane,
  type HighlightPart,
  type ReplayLine,
  type TuiRow,
} from "./tui-model.js";

export interface FineSearchPageProps {
  readonly context: Context;
  /** 斜杠命令带过来的初始查询（`/fs 连接池`）。 */
  readonly initialQuery: string;
  /** Esc 返回的目标页面（进入搜索页之前的路由）。 */
  readonly returnTo: Route;
}

type LoadState = "idle" | "loading" | "ready" | "error";
type View = "preview" | "replay";
type Pane = "list" | "detail";

interface Snapshot {
  query: string;
  filter: OverlayFilter;
  segmentId: number;
  view: View;
  showReasoning: boolean;
}

/** 离开页面后仍保留上次检索现场：从会话回来再按 /fs 能原样继续。 */
let snapshot: Snapshot | null = null;

interface PlainRow {
  readonly text: string;
  readonly color: string | RGBA;
}

interface ScreenRow {
  readonly text: string;
  readonly color: string | RGBA;
  readonly rich?: HighlightPart[];
}

interface Measured {
  getLayout(): { width: number; height: number };
}

export function FineSearchPage(props: FineSearchPageProps) {
  const context = props.context;
  const theme = context.theme;
  const base = theme.text.base;
  const accent = theme.hue.accent[300];
  const rpc = () => context.client.rpc(SearchRpc);

  const restored = snapshot;
  const initialText = props.initialQuery.trim();
  const restoreSegment = initialText ? -1 : (restored?.segmentId ?? -1);
  const restoreView: View = initialText ? "preview" : (restored?.view ?? "preview");

  // 页面可用区：路由页实测就是整屏，仍以根节点实测值为准，首帧用 renderer 兜底。
  const [size, setSize] = createSignal({
    width: context.renderer.width || 100,
    height: context.renderer.height || 30,
  });
  const [query, setQuery] = createSignal(initialText || (restored?.query ?? ""));
  const [filter, setFilter] = createSignal<OverlayFilter>(restored?.filter ?? "all");
  const [view, setView] = createSignal<View>(restoreView);
  const [pane, setPane] = createSignal<Pane>("list");
  const [showReasoning, setShowReasoning] = createSignal(restored?.showReasoning ?? false);

  const [statusLine, setStatusLine] = createSignal("正在确认索引状态…");
  const [indexReady, setIndexReady] = createSignal(true);
  const [infoLine, setInfoLine] = createSignal("");
  const [errorLine, setErrorLine] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [items, setItems] = createSignal<SearchOutputItem[]>([]);
  const [sel, setSel] = createSignal(-1);
  const [start, setStart] = createSignal(0);

  const [previewState, setPreviewState] = createSignal<LoadState>("idle");
  const [previewError, setPreviewError] = createSignal("");
  const [summary, setSummary] = createSignal<SummaryOutput | null>(null);
  const [segment, setSegment] = createSignal<ReadOutput | null>(null);

  const [streamState, setStreamState] = createSignal<LoadState>("idle");
  const [streamError, setStreamError] = createSignal("");
  const [streamItems, setStreamItems] = createSignal<StreamItem[]>([]);
  const [streamOffset, setStreamOffset] = createSignal(0);
  const [streamTotal, setStreamTotal] = createSignal(0);
  const [streamHasMore, setStreamHasMore] = createSignal(false);
  const [streamBusy, setStreamBusy] = createSignal<"" | "before" | "after">("");
  const [anchorExpanded, setAnchorExpanded] = createSignal(false);
  const [anchorFullText, setAnchorFullText] = createSignal<string | null>(null);
  const [replayScroll, setReplayScroll] = createSignal(0);
  const [replayTitle, setReplayTitle] = createSignal("");
  const [anchorSegment, setAnchorSegment] = createSignal(-1);

  let rootBox: Measured | undefined;
  let inputEl: { value: string } | undefined;

  const layout = createMemo(() => pageLayout(size().width, size().height));

  const rows = createMemo<TuiRow[]>(() =>
    buildRows(filterItems(items(), filter()), Date.now()),
  );
  const hitRows = createMemo(() => rows().filter((row) => row.type === "hit"));
  const windowed = createMemo(() => {
    const all = rows();
    const visible = Math.max(1, layout().listRows);
    // start 只是「尽量少动」的提示：终端变矮、结果变少或选中落在窗外时在这里收敛，
    // 否则选中行会跑到可见选框之外、窗口却不跟着翻页。
    const from = scrollStart(start(), sel(), all.length, visible);
    return { from, rows: all.slice(from, from + visible) };
  });
  const selectedHit = createMemo<SearchOutputItem | null>(() => {
    const row = rows()[sel()];
    return row && row.type === "hit" ? row.item : null;
  });
  const selectedIndex = createMemo(() => {
    const hit = selectedHit();
    if (!hit) return -1;
    return hitRows().findIndex((row) => row.type === "hit" && row.item.segmentId === hit.segmentId);
  });
  const terms = createMemo(() => termsOf(query()));

  const searchLane = tokenLane();
  const summaryLane = tokenLane();
  const readLane = tokenLane();
  const streamLane = tokenLane();
  const expandLane = tokenLane();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let measureTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (previewTimer !== undefined) clearTimeout(previewTimer);
    if (measureTimer !== undefined) clearTimeout(measureTimer);
    snapshot = {
      query: query(),
      filter: filter(),
      segmentId: selectedHit()?.segmentId ?? restoreSegment,
      view: view(),
      showReasoning: showReasoning(),
    };
  });

  function measure(): void {
    const el = rootBox;
    if (!el) return;
    const box = el.getLayout();
    const width = Math.round(box.width);
    const height = Math.round(box.height);
    if (width > 0 && height > 0) {
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    }
  }

  const onResize = () => {
    setSize({ width: context.renderer.width || 100, height: context.renderer.height || 30 });
    if (measureTimer !== undefined) clearTimeout(measureTimer);
    measureTimer = setTimeout(measure, 16);
  };
  context.renderer.on("resize", onResize);
  onCleanup(() => context.renderer.off("resize", onResize));

  function applySelection(index: number): void {
    setSel(index);
    setStart((prev) => scrollStart(prev, index, rows().length, layout().listRows));
  }

  function selectFirstHit(): void {
    applySelection(stepHits(rows(), -1, 1));
  }

  async function refreshStatus(): Promise<void> {
    try {
      const status = (await rpc().status({})) as StatusOutput;
      const ready = status.ready;
      setIndexReady(ready);
      setStatusLine(
        ready
          ? `${status.indexedSessions} 会话 · ${status.indexedMessages} 消息 · ${status.indexedSegments} 片段`
          : `索引未就绪：${status.reason || status.error || "未知原因"}`,
      );
    } catch (error) {
      setIndexReady(false);
      setStatusLine(`索引状态获取失败：${errorText(error) || "未知错误"}`);
    }
  }

  async function runSearch(
    value: string,
    restoreSegmentId: number = -1,
    viewAfter: View | null = null,
  ): Promise<void> {
    const text = value.trim();
    setQuery(text);
    setErrorLine("");
    if (!text) {
      setItems([]);
      setInfoLine("");
      applySelection(-1);
      return;
    }
    const mine = searchLane.begin();
    setBusy(true);
    try {
      const result = (await rpc().search({
        query: text,
        limit: SEARCH_LIMIT,
        includeReasoning: true,
        includeTools: true,
      })) as { mode: string; candidates: number; items: SearchOutputItem[] };
      if (!searchLane.isCurrent(mine)) return;
      setItems(result.items);
      setInfoLine(
        `模式 ${result.mode} · 候选 ${result.candidates} · 返回 ${result.items.length} · 筛选 ${filterLabel(filter())}`,
      );
      if (restoreSegmentId > 0) {
        const at = rows().findIndex(
          (row) => row.type === "hit" && row.item.segmentId === restoreSegmentId,
        );
        if (at >= 0) applySelection(at);
        else selectFirstHit();
      } else {
        selectFirstHit();
      }
      if (viewAfter === "replay") {
        setView("replay");
        const hit = selectedHit();
        if (hit) void loadStreamInitial(hit);
      }
    } catch (error) {
      if (!searchLane.isCurrent(mine)) return;
      setItems([]);
      applySelection(-1);
      setErrorLine(`搜索失败：${errorText(error) || "未知错误"}`);
    } finally {
      if (searchLane.isCurrent(mine)) setBusy(false);
    }
  }

  function cycleFilter(): void {
    setFilter((current) => nextFilter(current));
    setInfoLine((line) => (line ? line.replace(/筛选 .+$/, `筛选 ${filterLabel(filter())}`) : line));
    selectFirstHit();
  }

  async function loadPreview(hit: SearchOutputItem): Promise<void> {
    setPreviewState("loading");
    setPreviewError("");
    const summaryToken = summaryLane.begin();
    const readToken = readLane.begin();

    // 摘要失败不阻塞原文：置空后由 Show 分支隐藏摘要块。
    void (async () => {
      try {
        const result = (await rpc().summary({ sessionId: hit.sessionId })) as SummaryOutput;
        if (!summaryLane.isCurrent(summaryToken)) return;
        setSummary(result);
      } catch {
        if (summaryLane.isCurrent(summaryToken)) setSummary(null);
      }
    })();

    try {
      const result = (await rpc().read({ segmentId: hit.segmentId })) as ReadOutput;
      if (!readLane.isCurrent(readToken)) return;
      setSegment(result);
      setPreviewState("ready");
    } catch (error) {
      if (!readLane.isCurrent(readToken)) return;
      setSegment(null);
      setPreviewState("error");
      setPreviewError(errorText(error) || "未知错误");
    }
  }

  createEffect(() => {
    const hit = selectedHit();
    if (previewTimer !== undefined) clearTimeout(previewTimer);
    // 选中一变就作废在途请求：否则防抖窗口内旧响应会落成「新命中 + 旧原文」。
    summaryLane.begin();
    readLane.begin();
    if (!hit) {
      setSummary(null);
      setSegment(null);
      setPreviewState("idle");
      setPreviewError("");
      return;
    }
    previewTimer = setTimeout(() => void loadPreview(hit), DEBOUNCE_MS);
  });

  // 已在本页时再次 /fs <关键词>：路由 data 变了但组件不重挂，这里补一次真正的检索。
  createEffect(
    on(
      () => props.initialQuery,
      (value) => {
        const next = value.trim();
        if (!next || next === query()) return;
        void runSearch(next);
      },
      { defer: true },
    ),
  );

  const replayRowsMemo = createMemo<ReplayLine[]>(() =>
    replayLines(streamItems(), {
      anchorSegmentId: anchorSegment(),
      showReasoning: showReasoning(),
      anchorExpanded: anchorExpanded(),
      anchorFullText: anchorFullText(),
      width: layout().replayWidth,
    }),
  );

  const replayWindow = createMemo(() => {
    const all = replayRowsMemo();
    const from = Math.max(0, Math.min(replayScroll(), Math.max(0, all.length - 1)));
    return all.slice(from, from + layout().replayRows);
  });

  async function loadStreamInitial(hit: SearchOutputItem): Promise<void> {
    const mine = streamLane.begin();
    setAnchorSegment(hit.segmentId);
    setStreamState("loading");
    setStreamError("");
    setStreamItems([]);
    setStreamOffset(0);
    setStreamTotal(0);
    setStreamHasMore(false);
    // 切换命中时上一次分页请求可能还在路上（token 会丢弃它），busy 必须手动复位。
    setStreamBusy("");
    setAnchorExpanded(false);
    setAnchorFullText(null);
    try {
      const result = (await rpc().stream({
        sessionId: hit.sessionId,
        anchorSegmentId: hit.segmentId,
        limit: STREAM_PAGE,
      })) as StreamOutput;
      if (!streamLane.isCurrent(mine)) return;
      setReplayTitle(result.title);
      setStreamTotal(result.total);
      setStreamOffset(result.offset);
      setStreamHasMore(result.hasMore);
      setStreamItems(result.items);
      setStreamState("ready");
      const lines = replayLines(result.items, {
        anchorSegmentId: hit.segmentId,
        showReasoning: showReasoning(),
        anchorExpanded: false,
        anchorFullText: null,
        width: layout().replayWidth,
      });
      const at = firstLineIndexFor(lines, hit.segmentId);
      setReplayScroll(Math.max(0, at - 4));
    } catch (error) {
      if (!streamLane.isCurrent(mine)) return;
      setStreamState("error");
      setStreamError(errorText(error) || "未知错误");
    }
  }

  async function loadMore(direction: "before" | "after"): Promise<void> {
    const hit = selectedHit();
    if (!hit || streamBusy()) return;
    if (direction === "after" && !streamHasMore()) return;
    const current = streamOffset();
    // 翻页按「已加载条数」推进：before 用页宽回退（handoff §2.2）。
    const target =
      direction === "before"
        ? nextOffset(current, STREAM_PAGE, "before")
        : nextOffset(current, streamItems().length, "after");
    if (direction === "before" && target >= current) return;

    const mine = streamLane.begin();
    setStreamBusy(direction);
    setStreamError("");
    const topSegment = streamItems()[0]?.segmentId ?? -1;
    try {
      const result = (await rpc().stream({
        sessionId: hit.sessionId,
        offset: target,
        limit: STREAM_PAGE,
      })) as StreamOutput;
      if (!streamLane.isCurrent(mine)) return;
      const merged = mergeItems(streamItems(), result.items);
      setStreamItems(merged);
      if (direction === "before") {
        setStreamOffset(result.offset);
        // 视口补偿回原顶部片段，避免跳动。
        const keep = firstLineIndexFor(replayRowsMemo(), topSegment);
        if (keep >= 0) setReplayScroll(keep);
      } else {
        setStreamHasMore(result.hasMore);
      }
    } catch (error) {
      if (streamLane.isCurrent(mine)) setStreamError(errorText(error) || "分页加载失败");
    } finally {
      if (streamLane.isCurrent(mine)) setStreamBusy("");
    }
  }

  function toggleView(): void {
    if (view() === "replay") {
      setView("preview");
      return;
    }
    if (!selectedHit()) return;
    setView("replay");
  }

  /** 窄屏单栏时 Tab 在「列表 → 摘要 → 回放」之间循环。 */
  function cyclePane(): void {
    if (layout().wide) {
      toggleView();
      return;
    }
    if (pane() === "list") {
      setPane("detail");
      setView("preview");
      return;
    }
    if (view() === "preview") {
      setView("replay");
      return;
    }
    setPane("list");
    setView("preview");
  }

  /** 离开搜索页：页面占着当前标签，直接导航回进入前的路由。 */
  function leavePage(): void {
    context.ui.router.navigate(props.returnTo);
  }

  function openSession(): void {
    const hit = selectedHit();
    if (!hit) {
      context.ui.toast.show({ message: "先用 ↑↓ 选中一条命中", variant: "info" });
      return;
    }
    try {
      // 保持搜索页：命中会话在后台标签打开，当前页面与检索现场都不动。
      if (context.ui.tabs.enabled() && context.ui.tabs.open(hit.sessionId)) {
        context.ui.toast.show({
          message: "已在新标签打开会话；Ctrl+Tab 切过去，本页保持不动",
          variant: "info",
        });
        return;
      }
      context.ui.router.navigate({ type: "session", sessionID: hit.sessionId });
    } catch (error) {
      setErrorLine(`打开会话失败：${errorText(error)}`);
    }
  }

  async function expandAnchor(): Promise<void> {
    const hit = selectedHit();
    if (!hit || view() !== "replay") return;
    if (anchorExpanded()) {
      setAnchorExpanded(false);
      return;
    }
    const mine = expandLane.begin();
    try {
      const result = (await rpc().read({ segmentId: hit.segmentId })) as ReadOutput;
      if (!expandLane.isCurrent(mine)) return;
      setAnchorFullText(result.text);
      setAnchorExpanded(true);
    } catch (error) {
      if (expandLane.isCurrent(mine)) setStreamError(`展开本条失败：${errorText(error)}`);
    }
  }

  // 回放期间换命中必须重新锚定（handoff §2.3）。
  createEffect(() => {
    if (view() !== "replay") return;
    const hit = selectedHit();
    if (!hit || hit.segmentId === anchorSegment()) return;
    // 换锚点前作废旧锚点的「展开全文」请求，否则旧全文会挂到新命中上。
    expandLane.begin();
    setAnchorExpanded(false);
    setAnchorFullText(null);
    void loadStreamInitial(hit);
  });

  context.keymap.layer(() => ({
    mode: "global",
    priority: 1000,
    commands: [
      {
        id: "fine.search.up",
        title: "全文检索：上一条/上滚",
        bind: "up,ctrl+p",
        run: () => {
          if (view() === "replay") {
            setReplayScroll((s) => moveScroll(s, -1, replayRowsMemo().length));
            return;
          }
          applySelection(stepHits(rows(), sel(), -1));
        },
      },
      {
        id: "fine.search.down",
        title: "全文检索：下一条/下滚",
        bind: "down,ctrl+n",
        run: () => {
          if (view() === "replay") {
            setReplayScroll((s) => moveScroll(s, 1, replayRowsMemo().length));
            return;
          }
          applySelection(stepHits(rows(), sel(), 1));
        },
      },
      {
        id: "fine.search.page.up",
        title: "全文检索：上十条/加载更早",
        bind: "pageup",
        run: () => {
          if (view() === "replay") {
            void loadMore("before");
            return;
          }
          applySelection(stepHits(rows(), sel(), -PAGE_HITS));
        },
      },
      {
        id: "fine.search.page.down",
        title: "全文检索：下十条/加载更后",
        bind: "pagedown",
        run: () => {
          if (view() === "replay") {
            void loadMore("after");
            return;
          }
          applySelection(stepHits(rows(), sel(), PAGE_HITS));
        },
      },
      {
        id: "fine.search.view",
        title: "全文检索：摘要/回放切换",
        bind: "tab",
        run: () => cyclePane(),
      },
      {
        id: "fine.search.expand",
        title: "全文检索：展开命中条全文",
        bind: "ctrl+j",
        run: () => void expandAnchor(),
      },
      {
        id: "fine.search.thinking",
        title: "全文检索：思考显隐",
        bind: "ctrl+t",
        run: () => setShowReasoning((on) => !on),
      },
      {
        id: "fine.search.filter",
        title: "全文检索：切换筛选",
        bind: "ctrl+o,ctrl+0",
        run: () => cycleFilter(),
      },
      {
        id: "fine.search.clear",
        title: "全文检索：清空查询",
        bind: "ctrl+u",
        run: () => {
          if (inputEl) inputEl.value = "";
          void runSearch("");
        },
      },
      {
        id: "fine.search.open-session",
        title: "全文检索：打开会话",
        bind: "return",
        run: () => openSession(),
      },
      {
        id: "fine.search.close",
        title: "全文检索：返回",
        bind: "escape",
        run: () => leavePage(),
      },
    ],
    bindings: [
      "fine.search.up",
      "fine.search.down",
      "fine.search.page.up",
      "fine.search.page.down",
      "fine.search.view",
      "fine.search.expand",
      "fine.search.thinking",
      "fine.search.filter",
      "fine.search.clear",
      "fine.search.open-session",
      "fine.search.close",
    ],
  }));

  function bootstrap(): void {
    void (async () => {
      await refreshStatus();
      if (query()) await runSearch(query(), restoreSegment, restoreView);
    })();
    setTimeout(measure, 32);
  }
  bootstrap();

  const listState = createMemo(() => {
    if (!indexReady()) return "not-ready";
    if (busy()) return "loading";
    if (errorLine()) return "error";
    if (!query()) return "idle";
    if (rows().length === 0) return "empty";
    return "ready";
  });

  const preview = createMemo(() => {
    const seg = segment();
    if (!seg) return { lines: [] as string[], hidden: 0 };
    return previewView(seg.text, layout().textWidth, layout().previewLines);
  });

  const replayProgress = createMemo(() => {
    const loaded = streamItems().length;
    if (streamTotal() === 0) return "0 / 0";
    return `已载 ${streamOffset() + 1}–${streamOffset() + loaded} / 共 ${streamTotal()}`;
  });

  const projectLine = createMemo(() => {
    const hit = selectedHit();
    if (!hit) return "";
    const project = summary()?.project || projectName(hit.directory);
    return `${project}  ·  ${formatWhen(hit.ts)}  ·  ${kindLabel(hit.kind)}`;
  });

  const footerHint = createMemo(() => {
    if (!layout().wide) {
      return "↑↓ 移动 · PgUp/PgDn 翻页 · Tab 列表/摘要/回放 · Ctrl+O 筛选 · Enter 打开 · Esc 返回";
    }
    return "↑↓ 移动 · PgUp/PgDn 翻页 · Tab 摘要/回放 · Ctrl+O 筛选 · Ctrl+T 思考 · Ctrl+J 展开 · Enter 打开 · Esc 返回";
  });

  /** 各类型命中数（基于未筛选的结果，切换时才看得出差别）。 */
  const filterCounts = createMemo(() => {
    const counts: Record<OverlayFilter, number> = {
      all: items().length,
      assistant: 0,
      tool: 0,
      reasoning: 0,
      user: 0,
    };
    for (const item of items()) {
      if (item.kind === "assistant") counts.assistant += 1;
      else if (item.kind === "tool") counts.tool += 1;
      else if (item.kind === "reasoning") counts.reasoning += 1;
      else if (item.kind === "user") counts.user += 1;
    }
    return counts;
  });

  /** 筛选条（放不下就少显示几档，不让它换行）。 */
  const filterChips = createMemo(() => {
    const counts = filterCounts();
    const limit = layout().width - 18;
    const chips: { id: OverlayFilter; text: string; active: boolean }[] = [];
    let used = 6; // " 筛选 "
    for (const option of FILTERS) {
      const text = `${option.label} ${counts[option.id]}`;
      const width = displayWidth(text) + 3;
      if (chips.length > 0 && used + width > limit) break;
      chips.push({ id: option.id, text, active: filter() === option.id });
      used += width;
    }
    return chips;
  });

  const info = createMemo(() => {
    const parts: string[] = [];
    if (infoLine()) parts.push(infoLine());
    if (showReasoning()) parts.push("思考已展开");
    if (!layout().wide) parts.push(pane() === "list" ? "单栏：列表" : "单栏：详情");
    return parts.join("  ·  ");
  });

  /** 左右对齐的一行（按显示宽度补空格）。 */
  function padRow(left: string, right: string, width: number): string {
    const gap = Math.max(1, width - displayWidth(left) - displayWidth(right));
    return left + " ".repeat(gap) + right;
  }

  /** 左栏逐行数据：状态文案或命中行，行数不超过可见高度。 */
  const leftRows = createMemo<PlainRow[]>(() => {
    const state = listState();
    if (state === "not-ready") {
      return [
        { text: "索引未就绪，无法检索。", color: theme.text.faint },
        { text: "运行 node plugin/worker.mjs sync 重建。", color: theme.text.faint },
      ];
    }
    if (state === "loading") return [{ text: "搜索中…", color: theme.text.muted }];
    if (state === "idle") return [{ text: "输入关键词开始检索。", color: theme.text.faint }];
    if (state === "empty") {
      const rows: PlainRow[] = [{ text: "没有命中。", color: theme.text.faint }];
      if (filter() !== "all") {
        rows.push({ text: `按 Ctrl+O 切回「全部」（当前：${filterLabel(filter())}）`, color: theme.text.faint });
      }
      return rows;
    }
    if (state === "error") return [{ text: errorLine(), color: theme.text.muted }];
    const from = windowed().from;
    return windowed().rows.map((row: TuiRow, i) => {
      const isSel = row.type === "hit" && from + i === sel();
      const prefix = row.type === "hit" && isSel ? "❯ " : "  ";
      return {
        text: clipDisplay(prefix + row.text, layout().listTextWidth),
        color:
          row.type === "header"
            ? theme.text.faint
            : isSel
              ? theme.text.base
              : theme.text.muted,
      };
    });
  });

  /** 右栏逐行数据：照搬 GUI 详情栏（项目/会话/标签/摘要/原文或回放）。 */
  const rightRows = createMemo<ScreenRow[]>(() => {
    const w = layout().textWidth;
    const body = layout().bodyHeight;
    const hit = selectedHit();
    const total = hitRows().length;
    const at = selectedIndex();
    const rows: ScreenRow[] = [];

    rows.push({
      text: padRow("全文检索 · 详情", hit ? `第 ${at + 1} / 共 ${total} 条` : "", w),
      color: theme.text.faint,
    });

    if (!hit) {
      rows.push({
        text: previewState() === "loading" ? "详情加载中…" : "↑↓ 选择命中查看详情。",
        color: previewState() === "loading" ? theme.text.muted : theme.text.faint,
      });
      return rows;
    }
    if (previewState() === "error") {
      rows.push({ text: `详情失败：${previewError()}`, color: theme.text.muted });
      return rows;
    }
    if (previewState() !== "ready") {
      rows.push({ text: "详情加载中…", color: theme.text.muted });
      return rows;
    }

    rows.push({ text: projectLine(), color: theme.text.base });
    rows.push({ text: hit.title || "(无标题会话)", color: theme.text.base });
    rows.push({
      text: `[${kindLabel(hit.kind)}]${hit.kind === "tool" ? " [tool]" : ""} [查询：${query()}]`,
      color: theme.text.faint,
    });

    if (view() === "preview") {
      const summaryValue = summary();
      if (summaryValue) {
        rows.push({ text: "── 当时在做 ──", color: theme.text.faint });
        for (const line of clipLines(summaryValue.doing, w, 2)) {
          rows.push({ text: line || "（无）", color: theme.text.muted });
        }
        rows.push({ text: "── 解决 ──", color: theme.text.faint });
        for (const line of clipLines(summaryValue.solved, w, 2)) {
          rows.push({ text: line || "（无）", color: theme.text.muted });
        }
        rows.push({
          text: `来源 ${sourceLabel(summaryValue.source)} · 共 ${summaryValue.sessionCount} 会话`,
          color: theme.text.faint,
        });
      }
      rows.push({ text: padRow("── 原文 ──", "[摘要] [回放]", w), color: theme.text.faint });
      for (const line of preview().lines) {
        rows.push({ text: line, color: base, rich: highlightParts(line, terms()) });
      }
    } else {
      rows.push({ text: padRow("── 回放 ──", "[摘要] [回放]", w), color: theme.text.faint });
      rows.push({
        text: `${replayTitle() || hit.title || ""} · ${replayProgress()}`,
        color: theme.text.faint,
      });
      if (streamBusy() === "before") rows.push({ text: "加载更早…", color: theme.text.muted });
      if (streamState() === "loading") rows.push({ text: "回放加载中…", color: theme.text.muted });
      if (streamState() === "error") rows.push({ text: `回放失败：${streamError()}`, color: theme.text.muted });
      if (streamState() === "ready" && replayRowsMemo().length === 0) {
        rows.push({ text: "这个会话没有可回放的片段。", color: theme.text.faint });
      }
      for (const line of replayWindow()) {
        rows.push({
          text: clipDisplay(line.text, layout().replayWidth),
          color: replayToneColor(line),
        });
      }
      if (streamBusy() === "after") rows.push({ text: "加载更后…", color: theme.text.muted });
    }

    const hint =
      view() === "preview"
        ? `片段 ${at + 1} / ${total} · Tab 切换摘要/回放 · Ctrl+J 展开命中`
        : "↑↓ 滚动 · PgUp/PgDn 更早/更后 · Tab 回摘要";
    const visible = rows.slice(0, Math.max(1, body - 1));
    visible.push({ text: hint, color: theme.text.faint });
    return visible.slice(0, body);
  });

  function replayToneColor(line: ReplayLine): string | RGBA {
    if (line.tone === "head") return line.hit ? accent : theme.text.faint;
    if (line.tone === "body") return line.hit ? base : theme.text.muted;
    return theme.text.faint;
  }

  function renderPlainRow(row: PlainRow) {
    return (
      <text wrapMode="none" truncate height={1} fg={row.color}>
        {row.text}
      </text>
    );
  }

  function renderScreenRow(row: ScreenRow) {
    const hits = row.rich?.filter((part) => part.hit) ?? [];
    if (!hits.length) {
      return (
        <text wrapMode="none" truncate height={1} fg={row.color}>
          {row.text}
        </text>
      );
    }
    // span 的 fg 未在 @opentui/solid 0.8.2 的类型里暴露（SpanProps.style 为空），
    // 运行时 core 认这个属性，故用展开绕过本地类型。
    return (
      <text wrapMode="none" truncate height={1}>
        <For each={row.rich}>
          {(part) => (
            <span {...({ fg: part.hit ? accent : row.color } as Record<string, unknown>)}>
              {part.text}
            </span>
          )}
        </For>
      </text>
    );
  }

  return (
    <box
      ref={(el: unknown) => {
        rootBox = el as Measured;
      }}
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={theme.background.base}
      onSizeChange={() => {
        if (measureTimer !== undefined) clearTimeout(measureTimer);
        measureTimer = setTimeout(measure, 16);
      }}
    >
      <box flexDirection="row" width="100%" height={1}>
        <text fg={accent} height={1}>
          {" 全文检索"}
        </text>
        <box flexGrow={1} />
        <text fg={theme.text.faint} height={1}>
          {clipDisplay(statusLine(), Math.max(12, layout().width - 16))}
        </text>
      </box>

      <box flexDirection="row" width="100%" height={1}>
        <text fg={theme.text.faint} height={1}>
          {" 查询 ▏"}
        </text>
        <input
          ref={(el: unknown) => {
            inputEl = el as { value: string };
          }}
          width={Math.max(10, layout().width - 20)}
          value={initialText || (restored?.query ?? "")}
          focused
          placeholder="搜索全部会话（≥3 字 trigram，1–2 字 LIKE）"
          onInput={(value: string) => {
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(() => void runSearch(value), DEBOUNCE_MS);
          }}
        />
        <text fg={theme.text.faint} height={1}>
          {` ${filterLabel(filter())}`}
        </text>
      </box>

      <box flexDirection="row" width="100%" height={1}>
        <text fg={theme.text.faint} height={1} wrapMode="none">
          {" 筛选 "}
        </text>
        <For each={filterChips()}>
          {(chip) => (
            <text
              fg={chip.active ? accent : theme.text.faint}
              height={1}
              wrapMode="none"
              truncate
            >
              {`${chip.active ? "[" : " "}${chip.text}${chip.active ? "]" : " "}`}
            </text>
          )}
        </For>
        <box flexGrow={1} />
        <Show when={layout().width >= 110}>
          <text fg={theme.text.faint} height={1}>
            Ctrl+O 切换
          </text>
        </Show>
      </box>

      <text fg={errorLine() ? theme.text.base : theme.text.muted} height={1} wrapMode="none" truncate>
        {clipDisplay(info() || "输入关键词开始检索", Math.max(16, layout().width - 2))}
      </text>

      <box flexDirection="row" width="100%" height={layout().bodyHeight}>
        <Show when={layout().wide || pane() === "list"}>
          <box
            width={layout().left}
            flexDirection="column"
            height={layout().bodyHeight}
            border
            borderColor={theme.border.base}
            paddingLeft={1}
          >
            <For each={leftRows()}>{(row) => renderPlainRow(row)}</For>
          </box>
        </Show>

        <Show when={layout().wide}>
          <text fg={theme.border.base} height={layout().bodyHeight}>
            │
          </text>
        </Show>

        <Show when={layout().wide || pane() === "detail"}>
          <box
            width={layout().right}
            flexDirection="column"
            height={layout().bodyHeight}
            paddingLeft={1}
          >
            <For each={rightRows()}>{(row) => renderScreenRow(row)}</For>
          </box>
        </Show>
      </box>

      <text fg={theme.text.faint} height={1} wrapMode="none" truncate>
        {clipDisplay(footerHint(), Math.max(20, layout().width - 1))}
      </text>
    </box>
  );
}
