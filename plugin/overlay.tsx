/**
 * 非模态全文搜索浮层。
 *
 * 挂在 `window.bottom` 插槽，用 `position: fixed` 脱离布局：
 * - 无 scrim 压黑，主界面与侧边栏保持可见；
 * - 透明遮罩只负责「点外面关闭」；
 * - ↑↓ / 悬停切换结果并即时预览，Enter 打开会话，Esc 只关浮层。
 *
 * 摘要与原文渲染复用 ./detail-parts，规则来自 ./panel-model。
 */

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import type { Context } from "@opencode/plugin/gui";

import { Highlight, SummaryBlock, TextBlock, errorText, type LoadState } from "./detail-parts";
import { formatWhen, kindLabel, termsOf } from "./panel-model";
import {
  FILTERS,
  clampIndex,
  filterItems,
  filterLabel,
  stepIndex,
  type OverlayFilter,
} from "./overlay-model";
import {
  SearchRpc,
  type ReadOutput,
  type SearchOutput,
  type SearchOutputItem,
  type SummaryOutput,
} from "./rpc";

export const OVERLAY_CSS = `
.oc-overlay {
  --oc-bg: var(--v2-background-bg-layer-01, #1c1c1c);
  --oc-panel: var(--v2-background-bg-layer-02, #202020);
  --oc-line: var(--v2-border-border-muted, rgba(255,255,255,.08));
  --oc-line-strong: var(--v2-border-border-base, rgba(255,255,255,.14));
  --oc-text: var(--v2-text-text-base, #e8e8e8);
  --oc-muted: var(--v2-text-text-muted, #9a9a9a);
  --oc-faint: var(--v2-text-text-faint, #6f6f6f);
  --oc-accent: #7aa2f7;
  --oc-hit: rgba(250,204,21,.28);
  --oc-hit-text: #fde68a;
  position: fixed;
  inset: 0;
  z-index: 40;
  color: var(--oc-text);
  font-size: 12px;
  line-height: 1.55;
}
.oc-overlay[data-open="false"] { display: none; }
.oc-overlay-scrim { position: absolute; inset: 0; background: transparent; }
.oc-overlay-card {
  position: absolute;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  width: min(720px, calc(100vw - 96px));
  max-height: min(78vh, 780px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--oc-bg);
  border: 1px solid var(--oc-line-strong);
  border-radius: 8px;
  box-shadow: 0 24px 64px rgba(0,0,0,.45);
}
.oc-overlay-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--oc-line);
}
.oc-overlay-head .ico { display: inline-flex; color: var(--oc-faint); }
.oc-overlay-input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  padding: 2px 0;
}
.oc-overlay-input::placeholder { color: var(--oc-faint); }
.oc-overlay-busy { color: var(--oc-faint); font-size: 11px; white-space: nowrap; }
.oc-overlay-chip {
  flex: 0 0 auto;
  border: 1px solid var(--oc-line-strong);
  border-radius: 4px;
  padding: 0 5px;
  color: var(--oc-faint);
  font-size: 10px;
  line-height: 16px;
}
.oc-overlay-filters {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--oc-line);
}
.oc-overlay-filter {
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--oc-muted);
  font: inherit;
  font-size: 11px;
  padding: 1px 9px;
  cursor: pointer;
}
.oc-overlay-filter:hover { background: var(--v2-overlay-simple-overlay-hover, rgba(255,255,255,.06)); }
.oc-overlay-filter[data-active="true"] {
  background: var(--v2-overlay-simple-overlay-hover, rgba(255,255,255,.08));
  border-color: var(--oc-line-strong);
  color: var(--oc-text);
}
.oc-overlay-count { margin-left: auto; color: var(--oc-faint); font-size: 11px; white-space: nowrap; }
.oc-overlay-list {
  flex: 1 1 auto;
  min-height: 96px;
  overflow: auto;
  padding: 4px 6px;
}
.oc-overlay-row {
  display: block;
  width: 100%;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  padding: 6px 8px;
  cursor: pointer;
}
.oc-overlay-row:hover { background: var(--v2-overlay-simple-overlay-hover, rgba(255,255,255,.05)); }
.oc-overlay-row[data-active="true"] {
  background: var(--v2-overlay-simple-overlay-hover, rgba(122,162,247,.16));
  box-shadow: inset 2px 0 0 var(--oc-accent);
}
.oc-overlay-row .top { display: flex; align-items: baseline; gap: 8px; }
.oc-overlay-row .time { flex: 0 0 auto; color: var(--oc-faint); font-size: 11px; }
.oc-overlay-row .kind { flex: 0 0 auto; color: var(--oc-faint); font-size: 11px; }
.oc-overlay-row .title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.oc-overlay-row .snip {
  display: block;
  margin-top: 2px;
  color: var(--oc-muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.oc-overlay-row mark {
  background: var(--oc-hit);
  color: var(--oc-hit-text);
  border-radius: 2px;
  padding: 0 1px;
}
.oc-overlay-empty { padding: 18px 12px; color: var(--oc-muted); font-size: 12px; line-height: 1.8; }
.oc-overlay-preview {
  flex: 1 1 auto;
  min-height: 0;
  max-height: 52%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--oc-line);
  overflow: hidden;
}
.oc-overlay-meta { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.oc-overlay-project {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 8px;
  border: 1px solid var(--oc-line);
  border-radius: 6px;
  background: var(--oc-panel);
  color: var(--oc-muted);
  font-size: 11px;
}
.oc-overlay-project .sq {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
  background: var(--oc-accent);
  opacity: .85;
}
.oc-overlay-when { margin-left: auto; color: var(--oc-faint); font-size: 11px; white-space: nowrap; }
.oc-overlay-preview .oc-detail-context { max-height: 150px; }
.oc-overlay-preview .oc-detail-hit-wrap { min-height: 0; }
`;

const SEARCH_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 100;
const PREVIEW_DEBOUNCE_MS = 120;
const SUMMARY_CACHE_MAX = 80;

export interface SearchOverlayProps {
  ctx: Context;
  open: () => boolean;
  onClose: () => void;
  onOpen: (item: SearchOutputItem) => void;
}

function baseName(directory: string): string {
  const value = String(directory || "").replace(/[\\/]+$/, "");
  return value.split(/[\\/]/).pop() || "(未知项目)";
}

export function SearchOverlay(props: SearchOverlayProps) {
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<OverlayFilter>("all");
  const [raw, setRaw] = createSignal<SearchOutputItem[]>([]);
  const [searchState, setSearchState] = createSignal<LoadState>("idle");
  const [searchError, setSearchError] = createSignal("");
  const [active, setActive] = createSignal(0);

  const [summary, setSummary] = createSignal<SummaryOutput | null>(null);
  const [summaryState, setSummaryState] = createSignal<LoadState>("idle");
  const [summaryError, setSummaryError] = createSignal("");
  const [text, setText] = createSignal("");
  const [readState, setReadState] = createSignal<LoadState>("idle");
  const [readError, setReadError] = createSignal("");
  const [expanded, setExpanded] = createSignal(false);

  const summaryCache = new Map<string, SummaryOutput>();
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let searchToken = 0;
  let previewToken = 0;
  let inputEl: HTMLInputElement | undefined;

  const terms = createMemo(() => termsOf(query()));
  const results = createMemo(() => filterItems(raw(), filter()));
  const activeIndex = createMemo(() => clampIndex(active(), results().length));
  const current = createMemo(() => results()[activeIndex()]);

  const project = createMemo(() => {
    const value = summary()?.project;
    return value || (current() ? baseName(current()!.directory) : "");
  });

  const countText = createMemo(() => {
    if (!query().trim()) return "";
    const shown = results().length;
    const total = raw().length;
    if (searchState() === "loading" && total === 0) return "";
    return shown === total ? `${shown} 条` : `${shown} / ${total} 条`;
  });

  function resetPreview() {
    setText("");
    setReadState("idle");
    setReadError("");
    setSummary(null);
    setSummaryState("idle");
    setSummaryError("");
    setExpanded(false);
  }

  async function loadPreview(item: SearchOutputItem) {
    const token = ++previewToken;
    setText("");
    setReadError("");
    setReadState("loading");
    setExpanded(false);

    const cached = summaryCache.get(item.sessionId);
    if (cached) {
      setSummary(cached);
      setSummaryState("ready");
      setSummaryError("");
    } else {
      setSummary(null);
      setSummaryState("loading");
      setSummaryError("");
    }

    try {
      const result = (await props.ctx.client.rpc(SearchRpc).read({
        segmentId: item.segmentId,
      })) as ReadOutput;
      if (token !== previewToken) return;
      if (!result || typeof result.text !== "string") throw new Error("原文加载失败");
      setText(result.text);
      setReadState("ready");
    } catch (error) {
      if (token !== previewToken) return;
      setReadState("error");
      setReadError(errorText(error) || "原文加载失败");
    }

    if (cached) return;

    try {
      const result = (await props.ctx.client.rpc(SearchRpc).summary({
        sessionId: item.sessionId,
      })) as SummaryOutput;
      if (token !== previewToken) return;
      if (!result || typeof result.source !== "string") throw new Error("摘要加载失败");
      if (summaryCache.size >= SUMMARY_CACHE_MAX) {
        const oldest = summaryCache.keys().next().value;
        if (typeof oldest === "string") summaryCache.delete(oldest);
      }
      summaryCache.set(item.sessionId, result);
      setSummary(result);
      setSummaryState("ready");
    } catch (error) {
      if (token !== previewToken) return;
      setSummaryState("error");
      setSummaryError(errorText(error) || "摘要加载失败");
    }
  }

  function openItem(item: SearchOutputItem) {
    props.onOpen(item);
    props.onClose();
  }

  function move(delta: number) {
    const count = results().length;
    if (count < 1) return;
    setActive(stepIndex(activeIndex(), delta, count));
  }

  function onInputKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const item = current();
      if (item) openItem(item);
    }
  }

  // 输入 100ms 防抖；旧请求用序号丢弃。
  createEffect(
    on(query, (value) => {
      const text = value.trim();
      const token = ++searchToken;
      clearTimeout(searchTimer);
      if (!text) {
        setRaw([]);
        setSearchState("idle");
        setSearchError("");
        resetPreview();
        return;
      }

      setSearchState("loading");
      setSearchError("");
      searchTimer = setTimeout(() => {
        void (async () => {
          try {
            const result = (await props.ctx.client.rpc(SearchRpc).search({
              query: text,
              limit: SEARCH_LIMIT,
              includeReasoning: true,
              includeTools: true,
            })) as SearchOutput;
            if (token !== searchToken) return;
            if (!result || !Array.isArray(result.items)) throw new Error("搜索结果格式异常");
            setRaw(result.items);
            setSearchState("ready");
            setActive(0);
          } catch (error) {
            if (token !== searchToken) return;
            setRaw([]);
            setSearchState("error");
            setSearchError(errorText(error) || "搜索失败");
          }
        })();
      }, SEARCH_DEBOUNCE_MS);
    }),
  );

  // 结果集变化（新查询 / 切筛选）后回到第一条。
  createEffect(
    on(results, () => {
      setActive(0);
    }),
  );

  // 当前结果变化 → 120ms 后拉原文与摘要。
  createEffect(
    on(
      () => current()?.segmentId,
      () => {
        clearTimeout(previewTimer);
        const item = current();
        if (!item) {
          resetPreview();
          return;
        }
        previewTimer = setTimeout(() => void loadPreview(item), PREVIEW_DEBOUNCE_MS);
      },
    ),
  );

  // 打开时聚焦输入框；已有查询词全选，直接输入即可替换。
  createEffect(
    on(
      () => props.open(),
      (value) => {
        if (!value) return;
        setTimeout(() => {
          inputEl?.focus();
          inputEl?.select();
        }, 0);
      },
      { defer: true },
    ),
  );

  // Esc / ↑↓ 在 document 捕获阶段硬隔离：Kobalte 用同层监听，靠 stopImmediatePropagation 才能拦住。
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!props.open()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        props.onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopImmediatePropagation();
        move(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        move(-1);
      }
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  onCleanup(() => {
    clearTimeout(searchTimer);
    clearTimeout(previewTimer);
  });

  const emptyText = createMemo(() => {
    if (searchState() === "loading") return "正在搜索…";
    if (filter() !== "all") {
      return `「${filterLabel(filter())}」下没有命中，试试「全部」。`;
    }
    return "没有命中，换个关键词或更短的词。";
  });

  return (
    <div class="oc-overlay" data-open={props.open() ? "true" : "false"}>
      <div class="oc-overlay-scrim" onClick={props.onClose} />

      <div class="oc-overlay-card" role="dialog" aria-label="搜索全部会话">
        <div class="oc-overlay-head">
          <span class="ico">
            <props.ctx.ui.Icon name="magnifying-glass" size="small" />
          </span>
          <input
            ref={(element) => {
              inputEl = element;
            }}
            class="oc-overlay-input"
            type="text"
            aria-label="搜索全部会话正文"
            placeholder="搜索全部会话正文…"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onInputKeyDown}
          />
          <Show when={searchState() === "loading"}>
            <span class="oc-overlay-busy">搜索中…</span>
          </Show>
          <span class="oc-overlay-chip">Esc</span>
        </div>

        <div class="oc-overlay-filters">
          <For each={FILTERS}>
            {(option) => (
              <button
                type="button"
                class="oc-overlay-filter"
                data-active={filter() === option.id ? "true" : "false"}
                onClick={() => setFilter(option.id)}
              >
                {option.label}
              </button>
            )}
          </For>
          <span class="oc-overlay-count">{countText()}</span>
        </div>

        <div class="oc-overlay-list" role="listbox" aria-label="搜索结果">
          <Show
            when={query().trim()}
            fallback={
              <div class="oc-overlay-empty">
                输入关键词，搜索全部会话正文。
                <br />
                ↑↓ 切换预览，Enter 打开会话，Esc 关闭。
              </div>
            }
          >
            <Show
              when={searchState() !== "error"}
              fallback={<div class="oc-overlay-empty">搜索失败：{searchError()}</div>}
            >
              <Show when={results().length} fallback={<div class="oc-overlay-empty">{emptyText()}</div>}>
                <For each={results()}>
                  {(item, index) => (
                    <button
                      type="button"
                      class="oc-overlay-row"
                      data-active={index() === activeIndex() ? "true" : "false"}
                      onMouseEnter={() => setActive(index())}
                      onClick={() => {
                        setActive(index());
                        openItem(item);
                      }}
                    >
                      <span class="top">
                        <span class="time">{formatWhen(item.ts)}</span>
                        <span class="kind">{kindLabel(item.kind)}</span>
                        <span class="title">{item.title || "(无标题会话)"}</span>
                      </span>
                      <span class="snip">
                        <Highlight text={item.snippet} terms={terms()} />
                      </span>
                    </button>
                  )}
                </For>
              </Show>
            </Show>
          </Show>
        </div>

        <Show when={current()}>
          {(item) => (
            <div class="oc-overlay-preview">
              <div class="oc-overlay-meta">
                <span class="oc-overlay-project">
                  <span class="sq" />
                  {project()}
                </span>
                <span class="oc-overlay-when">{formatWhen(item().ts)}</span>
              </div>

              <SummaryBlock
                summary={summary()}
                state={summaryState()}
                error={summaryError()}
                onRetry={() => void loadPreview(item())}
              />

              <TextBlock
                text={text()}
                terms={terms()}
                state={readState()}
                error={readError()}
                expanded={expanded()}
                onToggle={() => setExpanded((value) => !value)}
                onRetry={() => void loadPreview(item())}
              />
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}