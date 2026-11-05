/**
 * 非模态全文搜索浮层。
 *
 * 挂在 `window.bottom` 插槽，用 `position: fixed` 脱离布局：
 * - 无 scrim 压黑，主界面与侧边栏保持可见；
 * - 透明遮罩只负责「点外面关闭」；
 * - 浮层只放搜索框与结果列表；↑↓ / 悬停经 onSelect 驱动右侧详情栏，
 *   Enter 打开会话，Esc 只关浮层。
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

import { Highlight, errorText, type LoadState } from "./detail-parts";
import { formatWhen, kindLabel, termsOf } from "./panel-model";
import {
  FILTERS,
  cardBox,
  clampIndex,
  filterItems,
  filterLabel,
  stepIndex,
  type OverlayFilter,
} from "./overlay-model";
import {
  SearchRpc,
  type SearchOutput,
  type SearchOutputItem,
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
  left: var(--oc-card-left, 50%);
  transform: var(--oc-card-shift, translateX(-50%));
  width: var(--oc-card-width, min(720px, calc(100vw - 96px)));
  max-width: calc(100vw - 24px);
  max-height: min(74vh, 760px);
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
`;

const SEARCH_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 100;
const SELECT_DEBOUNCE_MS = 120;

export interface SearchOverlayProps {
  ctx: Context;
  open: () => boolean;
  onClose: () => void;
  onOpen: (item: SearchOutputItem) => void;
  /** 选中项变化：驱动右侧详情栏。 */
  onSelect: (item: SearchOutputItem, query: string) => void;
}

export function SearchOverlay(props: SearchOverlayProps) {
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<OverlayFilter>("all");
  const [raw, setRaw] = createSignal<SearchOutputItem[]>([]);
  const [searchState, setSearchState] = createSignal<LoadState>("idle");
  const [searchError, setSearchError] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [box, setBox] = createSignal<{ left: number; width: number } | null>(null);

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let selectTimer: ReturnType<typeof setTimeout> | undefined;
  let measureTimer: ReturnType<typeof setInterval> | undefined;
  let searchToken = 0;
  let inputEl: HTMLInputElement | undefined;

  const terms = createMemo(() => termsOf(query()));
  const results = createMemo(() => filterItems(raw(), filter()));
  const activeIndex = createMemo(() => clampIndex(active(), results().length));
  const current = createMemo(() => results()[activeIndex()]);

  const countText = createMemo(() => {
    if (!query().trim()) return "";
    const shown = results().length;
    const total = raw().length;
    if (searchState() === "loading" && total === 0) return "";
    return shown === total ? `${shown} 条` : `${shown} / ${total} 条`;
  });

  function openItem(item: SearchOutputItem) {
    props.onOpen(item);
    props.onClose();
  }

  function move(delta: number) {
    const count = results().length;
    if (count < 1) return;
    setActive(stepIndex(activeIndex(), delta, count));
  }

  /**
   * 量出「时间线左边界 → 详情栏左边界」的可用宽度，把卡片放进去。
   *
   * 左侧栏没有 DOM 契约，所以从标题行入口往上找第一个占宽超过视口 40% 的祖先，
   * 它的左边界就是时间线起点；找不到就退回整窗居中。详情栏用我们自己的
   * `.oc-detail` 量，面板开合 / 窗口缩放都会重算。
   */
  function measureCard() {
    if (typeof window === "undefined" || !props.open()) return;
    const viewportWidth = window.innerWidth;

    const panel = document.querySelector<HTMLElement>(".oc-detail");
    const panelWidth = panel ? panel.getBoundingClientRect().width : 0;

    // 缓存的会话时间线也会渲染标题行入口，只认当前在视口里的那个。
    const entries = Array.from(document.querySelectorAll<HTMLElement>(".oc-search-entry"));
    const visibleEntry =
      entries.find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
      }) ?? entries[0];

    let contentLeft = 0;
    let node: HTMLElement | null = visibleEntry ?? null;
    for (let depth = 0; depth < 8 && node; depth += 1) {
      const rect = node.getBoundingClientRect();
      if (rect.left > 4 && rect.width > viewportWidth * 0.4 && rect.width <= viewportWidth) {
        contentLeft = rect.left;
        break;
      }
      node = node.parentElement;
    }

    setBox(cardBox({ viewportWidth, panelWidth, contentLeft }));
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

  // 选中项 / 查询词变化 → 120ms 后把命中项交给右侧详情栏。
  createEffect(
    on(
      () => `${current()?.segmentId ?? ""}|${query().trim()}`,
      () => {
        clearTimeout(selectTimer);
        const item = current();
        if (!item) return;
        selectTimer = setTimeout(() => {
          props.onSelect(item, query().trim());
          // 面板可能刚被打开或改变宽度，下一帧再量一次。
          setTimeout(measureCard, 80);
        }, SELECT_DEBOUNCE_MS);
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
    window.addEventListener("resize", measureCard);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", measureCard);
    });
  });

  // 打开期间持续跟随布局（面板开合、拖宽、窗口缩放）。
  createEffect(
    on(() => props.open(), (value) => {
      clearInterval(measureTimer);
      if (!value) return;
      requestAnimationFrame(measureCard);
      measureTimer = setInterval(measureCard, 400);
    }),
  );

  onCleanup(() => {
    clearTimeout(searchTimer);
    clearTimeout(selectTimer);
    clearInterval(measureTimer);
  });

  const emptyText = createMemo(() => {
    if (searchState() === "loading") return "正在搜索…";
    if (filter() !== "all") {
      return `「${filterLabel(filter())}」下没有命中，试试「全部」。`;
    }
    return "没有命中，换个关键词或更短的词。";
  });

  return (
    <div
      class="oc-overlay"
      data-open={props.open() ? "true" : "false"}
      style={
        box()
          ? {
              "--oc-card-left": `${box()!.left}px`,
              "--oc-card-width": `${box()!.width}px`,
              "--oc-card-shift": "none",
            }
          : undefined
      }
    >
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
                ↑↓ 切换结果（右侧详情栏同步），Enter 打开会话，Esc 关闭。
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
      </div>
    </div>
  );
}