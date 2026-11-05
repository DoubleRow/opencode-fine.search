/** @jsxImportSource @opentui/solid */
/**
 * oc-search TUI 插件（P2）。
 *
 * 入口：`<leader>f` / 命令面板「全文检索」 / 斜杠 `/finesearch`（别名 `/fs`）。
 * 复用 server 插件已注册的 SearchRpc，不重写检索核心；
 * UI 只是薄壳，纯逻辑在 tui-model.ts（分组/导航/预览与 GUI 同口径）。
 *
 * 键位依据官方 docs/cli/keybinds（2026-11-05 实查）：`<leader>f`、`ctrl+o`
 * 未被默认输入编辑占用；对话框交互键仅在对话框存活期间以高优先级 global 层接管，
 * 随对话框销毁自动移除（见 docs/build/plugins/cli）。
 */

import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import { StyledText, fg as styledFg } from "@opentui/core";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

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
import { kindLabel, termsOf } from "./panel-model.js";
import { mergeItems, nextOffset } from "./stream-model.js";
import {
  DEBOUNCE_MS,
  LIST_WINDOW,
  PAGE_HITS,
  PREVIEW_LINES,
  PREVIEW_WIDTH,
  REPLAY_WINDOW,
  SEARCH_LIMIT,
  STREAM_PAGE,
  buildRows,
  clipLines,
  errorText,
  firstLineIndexFor,
  flatten,
  highlightParts,
  moveScroll,
  nextFilter,
  openPlan,
  previewView,
  projectName,
  replayLines,
  scrollStart,
  sourceLabel,
  stepHits,
  timeLabel,
  tokenLane,
  type ReplayLine,
  type TuiRow,
} from "./tui-model.js";

export default Plugin.define({
  id: "opencode-fine.search.tui",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "fine.search.open",
          title: "全文检索（历史会话）",
          group: "全文检索",
          bind: "<leader>f",
          palette: true,
          slash: { name: "finesearch", aliases: ["fs"] },
          run: () => openSearchDialog(context),
        },
      ],
      bindings: ["fine.search.open"],
    }));
  },
});

function openSearchDialog(context: Context): void {
  context.ui.dialog.set({ size: "xlarge", centered: true });
  context.ui.dialog.show(() => <SearchDialog context={context} />);
}

interface SearchDialogProps {
  context: Context;
}

type PreviewState = "idle" | "loading" | "ready" | "error";

function SearchDialog(props: SearchDialogProps) {
  const context = props.context;
  const theme = context.theme;
  const base = theme.text.base;
  const accent = theme.hue.accent[300];
  const rpc = () => context.client.rpc(SearchRpc);

  const [statusLine, setStatusLine] = createSignal("正在确认索引状态…");
  const [indexReady, setIndexReady] = createSignal(true);
  const [infoLine, setInfoLine] = createSignal("");
  const [errorLine, setErrorLine] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [items, setItems] = createSignal<SearchOutputItem[]>([]);
  const [filter, setFilter] = createSignal<OverlayFilter>("all");
  const [sel, setSel] = createSignal(-1);
  const [start, setStart] = createSignal(0);

  const [previewState, setPreviewState] = createSignal<PreviewState>("idle");
  const [previewError, setPreviewError] = createSignal("");
  const [summary, setSummary] = createSignal<SummaryOutput | null>(null);
  const [segment, setSegment] = createSignal<ReadOutput | null>(null);

  const [view, setView] = createSignal<"preview" | "replay">("preview");
  const [streamState, setStreamState] = createSignal<PreviewState>("idle");
  const [streamError, setStreamError] = createSignal("");
  const [streamItems, setStreamItems] = createSignal<StreamItem[]>([]);
  const [streamOffset, setStreamOffset] = createSignal(0);
  const [streamTotal, setStreamTotal] = createSignal(0);
  const [streamHasMore, setStreamHasMore] = createSignal(false);
  const [streamBusy, setStreamBusy] = createSignal<"" | "before" | "after">("");
  const [showReasoning, setShowReasoning] = createSignal(false);
  const [anchorExpanded, setAnchorExpanded] = createSignal(false);
  const [anchorFullText, setAnchorFullText] = createSignal<string | null>(null);
  const [replayScroll, setReplayScroll] = createSignal(0);
  const [replayTitle, setReplayTitle] = createSignal("");
  const [anchorSegment, setAnchorSegment] = createSignal(-1);

  const rows = createMemo<TuiRow[]>(() => buildRows(filterItems(items(), filter())));
  const windowed = createMemo(() => {
    const all = rows();
    const from = Math.max(0, Math.min(start(), all.length));
    return all.slice(from, from + LIST_WINDOW);
  });
  const selectedHit = createMemo<SearchOutputItem | null>(() => {
    const row = rows()[sel()];
    return row && row.type === "hit" ? row.item : null;
  });
  const terms = createMemo(() => termsOf(query()));

  const searchLane = tokenLane();
  const summaryLane = tokenLane();
  const readLane = tokenLane();
  const streamLane = tokenLane();
  const expandLane = tokenLane();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (previewTimer !== undefined) clearTimeout(previewTimer);
  });

  function applySelection(index: number): void {
    setSel(index);
    setStart((prev) => scrollStart(prev, index, rows().length, LIST_WINDOW));
  }

  /** 新结果或换筛选后，把选中重置到第一条命中。 */
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
          ? `索引就绪 · ${status.indexedSessions} 会话 / ${status.indexedMessages} 消息 / ${status.indexedSegments} 片段`
          : `索引未就绪：${status.reason || status.error || "未知原因"}`,
      );
    } catch (error) {
      setIndexReady(false);
      setStatusLine(`索引状态获取失败：${errorText(error) || "未知错误"}`);
    }
  }

  async function runSearch(value: string): Promise<void> {
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
      selectFirstHit();
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
    setInfoLine((line) =>
      line ? line.replace(/筛选 .+$/, `筛选 ${filterLabel(filter())}`) : line,
    );
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
    if (!hit) {
      setSummary(null);
      setSegment(null);
      setPreviewState("idle");
      setPreviewError("");
      return;
    }
    previewTimer = setTimeout(() => void loadPreview(hit), DEBOUNCE_MS);
  });

  const replayRowsMemo = createMemo<ReplayLine[]>(() =>
    replayLines(streamItems(), {
      anchorSegmentId: anchorSegment(),
      showReasoning: showReasoning(),
      anchorExpanded: anchorExpanded(),
      anchorFullText: anchorFullText(),
      width: PREVIEW_WIDTH,
    }),
  );

  const replayWindow = createMemo(() => {
    const all = replayRowsMemo();
    const from = Math.max(0, Math.min(replayScroll(), Math.max(0, all.length - 1)));
    return all.slice(from, from + REPLAY_WINDOW);
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
        width: PREVIEW_WIDTH,
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

  // Enter：打开命中所在会话并关闭对话框（标签页优先，回退整页路由）。
  function openSession(): void {
    const hit = selectedHit();
    if (!hit) {
      context.ui.toast.show({ message: "先用 ↑↓ 选中一条命中", variant: "info" });
      return;
    }
    for (const way of openPlan(context.ui.tabs.enabled())) {
      try {
        if (way === "tabs") {
          if (!context.ui.tabs.focus(hit.sessionId)) continue;
        } else {
          context.ui.router.navigate({ type: "session", sessionID: hit.sessionId });
        }
        context.ui.dialog.clear();
        return;
      } catch (error) {
        setErrorLine(`打开会话失败：${errorText(error)}`);
        return;
      }
    }
    setErrorLine("打开会话失败：标签页与路由都没能定位该会话");
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
    void loadStreamInitial(hit);
  });

  // 对话框级按键：随对话框销毁自动移除；不抢 Ctrl+C 等宿主键。
  // PgUp/PgDn 与 ↑↓ 的语义按「预览 / 回放」两种视图分流。
  context.keymap.layer(() => ({
    mode: "global",
    priority: 50,
    commands: [
      {
        id: "fine.search.up",
        title: "全文检索：上一条/上滚",
        bind: "up",
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
        bind: "down",
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
        title: "全文检索：预览/回放切换",
        bind: "tab",
        run: () => toggleView(),
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
        bind: "ctrl+o",
        run: () => cycleFilter(),
      },
      {
        id: "fine.search.open-session",
        title: "全文检索：打开会话",
        bind: "return",
        run: () => openSession(),
      },
      {
        id: "fine.search.close",
        title: "全文检索：关闭",
        bind: "escape",
        run: () => context.ui.dialog.clear(),
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
      "fine.search.open-session",
      "fine.search.close",
    ],
  }));

  void refreshStatus();

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
    return previewView(seg.text, PREVIEW_WIDTH, PREVIEW_LINES);
  });

  function renderHitLine(row: TuiRow, visibleIndex: number) {
    const isSelected = row.type === "hit" && start() + visibleIndex === sel();
    const color =
      row.type === "header"
        ? theme.text.faint
        : isSelected
          ? theme.text.base
          : theme.text.muted;
    return (
      <text fg={color}>
        {row.type === "hit" && isSelected ? "❯ " : "  "}
        {row.text}
      </text>
    );
  }

  function renderPreviewLine(line: string) {
    // span 的 fg 属性在 @opentui/solid 0.8.2 类型里未暴露，改走 core 的 StyledText 通道。
    const styled = new StyledText(
      highlightParts(line, terms()).map((part) => styledFg(part.hit ? accent : base)(part.text)),
    );
    return <text content={styled} />;
  }

  function renderReplayLine(line: ReplayLine) {
    const color =
      line.tone === "head"
        ? line.hit
          ? accent
          : theme.text.faint
        : line.tone === "body"
          ? line.hit
            ? base
            : theme.text.muted
          : theme.text.faint;
    return <text fg={color}>{line.text}</text>;
  }

  const replayProgress = createMemo(() => {
    const loaded = streamItems().length;
    if (streamTotal() === 0) return "0 / 0";
    return `已载 ${streamOffset() + 1}–${streamOffset() + loaded} / 共 ${streamTotal()}`;
  });

  const selectedSegment = createMemo(() => {
    const hit = selectedHit();
    return hit ? `${timeLabel(hit.ts)} ${kindLabel(hit.kind)} · ${flatten(hit.title)}` : "";
  });

  return (
    <box flexDirection="column" gap={1}>
      <input
        focused
        placeholder="搜索全部会话（输入即查；≥3 字走 trigram，1–2 字走 LIKE）"
        onInput={(value: string) => {
          if (timer !== undefined) clearTimeout(timer);
          timer = setTimeout(() => void runSearch(value), DEBOUNCE_MS);
        }}
      />
      <text fg={theme.text.muted}>{statusLine()}</text>
      <Show when={infoLine()}>
        <text fg={theme.text.muted}>{infoLine()}</text>
      </Show>
      <box flexDirection="row" gap={2}>
        <box width="40%" flexDirection="column" minHeight={LIST_WINDOW + 2}>
          <Show when={listState() === "not-ready"}>
            <text fg={theme.text.faint}>索引未就绪，无法检索。运行 node plugin/worker.mjs sync 重建。</text>
          </Show>
          <Show when={listState() === "loading"}>
            <text fg={theme.text.muted}>搜索中…</text>
          </Show>
          <Show when={listState() === "idle"}>
            <text fg={theme.text.faint}>输入关键词开始检索。</text>
          </Show>
          <Show when={listState() === "empty"}>
            <text fg={theme.text.faint}>没有命中。</text>
          </Show>
          <Show when={listState() === "error"}>
            <text fg={theme.text.muted}>{errorLine()}</text>
          </Show>
          <Show when={listState() === "ready"}>
            <For each={windowed()}>{(row, i) => renderHitLine(row, i())}</For>
          </Show>
        </box>
        <box width="60%" flexDirection="column">
          <Show when={view() === "preview"}>
            <Show when={previewState() === "idle"}>
              <text fg={theme.text.faint}>↑↓ 选择命中查看预览。</text>
            </Show>
            <Show when={previewState() === "loading"}>
              <text fg={theme.text.muted}>预览加载中…</text>
            </Show>
            <Show when={previewState() === "error"}>
              <text fg={theme.text.muted}>预览失败：{previewError()}</text>
            </Show>
            <Show when={previewState() === "ready" && segment()}>
              <text fg={theme.text.base}>{selectedSegment()}</text>
              <text fg={theme.text.faint}>
                {summary() ? `${summary()!.project}` : projectName(segment()?.directory ?? "")}
              </text>
              <Show when={summary()}>
                <For each={clipLines(summary()!.doing, PREVIEW_WIDTH, 3)}>
                  {(line) => <text fg={theme.text.muted}>当时在做 {line}</text>}
                </For>
                <For each={clipLines(summary()!.solved, PREVIEW_WIDTH, 3)}>
                  {(line) => <text fg={theme.text.muted}>解决 {line}</text>}
                </For>
                <text fg={theme.text.faint}>
                  来源 {sourceLabel(summary()!.source)} · 共 {summary()!.sessionCount} 会话
                </text>
              </Show>
              <text fg={theme.text.faint}>原文（前 {PREVIEW_LINES} 行）：</text>
              <For each={preview().lines}>{(line) => renderPreviewLine(line)}</For>
            </Show>
          </Show>
          <Show when={view() === "replay"}>
            <text fg={theme.text.faint}>
              只读回放 · {replayTitle()} · {replayProgress()}
            </text>
            <Show when={streamState() === "loading"}>
              <text fg={theme.text.muted}>回放加载中…</text>
            </Show>
            <Show when={streamState() === "error"}>
              <text fg={theme.text.muted}>回放失败：{streamError()}（↑↓ 重选命中可重试）</text>
            </Show>
            <Show when={streamState() === "ready" && replayRowsMemo().length === 0}>
              <text fg={theme.text.faint}>这个会话没有可回放的片段。</text>
            </Show>
            <Show when={streamState() === "ready" && replayRowsMemo().length > 0}>
              <Show when={streamError()}>
                <text fg={theme.text.muted}>分页失败：{streamError()}（可再次 PgUp/PgDn 重试）</text>
              </Show>
              <Show when={streamBusy() === "before"}>
                <text fg={theme.text.muted}>加载更早…</text>
              </Show>
              <For each={replayWindow()}>{(line) => renderReplayLine(line)}</For>
              <Show when={streamBusy() === "after"}>
                <text fg={theme.text.muted}>加载更后…</text>
              </Show>
              <Show when={streamBusy() !== "before" && streamHasMore()}>
                <text fg={theme.text.faint}>（PgDn 继续加载）</text>
              </Show>
            </Show>
          </Show>
        </box>
      </box>
      <text fg={theme.text.faint}>
        {view() === "replay"
          ? "↑↓ 滚动 · PgUp/PgDn 更早/更后 · Ctrl+T 思考 · Ctrl+J 展开命中 · Enter 打开会话 · Tab 回预览 · Esc 关闭"
          : `↑↓ 选择 · PgUp/PgDn 十条一跳 · Enter 打开会话 · Ctrl+O 筛选（${FILTERS.map((f) => f.label).join("/")}）· Tab 回放 · Esc 关闭`}
      </text>
    </box>
  );
}
