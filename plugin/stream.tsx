/**
 * 侧栏「整段会话流水」：只读回放，不是实时会话。
 *
 * - 按 messageId 分块，正文用接近会话页的字号与间距（不是预览的小字）；
 * - 思考默认收起为一行，工具输出按 2000 字截断、可展开取全文；
 * - 分页加载，锚点定位命中；底部「在标签页打开」才真正跳转。
 */

import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import type { Context } from "@opencode/plugin/gui";

import { Highlight, errorText, type LoadState } from "./detail-parts";
import { formatWhen, termsOf } from "./panel-model";
import {
  blockKind,
  groupByMessage,
  mergeItems,
  previewText,
  roleLabel,
} from "./stream-model";
import {
  SearchRpc,
  type ReadOutput,
  type StreamItem,
  type StreamOutput,
} from "./rpc";

export const STREAM_CSS = `
.oc-stream {
  --oc-s-line: var(--v2-border-border-muted, rgba(255,255,255,.08));
  --oc-s-line-strong: var(--v2-border-border-base, rgba(255,255,255,.14));
  --oc-s-text: var(--v2-text-text-base, #e8e8e8);
  --oc-s-muted: var(--v2-text-text-muted, #9a9a9a);
  --oc-s-faint: var(--v2-text-text-faint, #6f6f6f);
  --oc-s-layer: var(--v2-background-bg-layer-02, #202020);
  --oc-s-accent: #7aa2f7;
  --oc-s-hit: rgba(250,204,21,.28);
  --oc-s-hit-text: #fde68a;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  width: 100%;
  color: var(--oc-s-text);
  background: var(--v2-background-bg-layer-01, #1c1c1c);
}
.oc-stream { user-select: text; -webkit-user-select: text; }
.oc-stream-bar, .oc-stream-foot, .oc-stream-morebar, .oc-stream-think,
.oc-stream-expand, .oc-stream-bar button, .oc-stream-foot button {
  user-select: none; -webkit-user-select: none;
}
.oc-stream-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--oc-s-line);
  font-size: 12px;
}
.oc-stream-bar .title {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-weight: 600;
}
.oc-stream-badge {
  flex: 0 0 auto; padding: 1px 6px; border-radius: 999px; font-size: 10px;
  border: 1px solid var(--oc-s-line-strong); color: var(--oc-s-muted); background: rgba(255,255,255,.04);
}
.oc-stream-badge.readonly { color: #d7c3ff; border-color: rgba(167,139,250,.35); background: rgba(167,139,250,.10); }
.oc-stream-badge.current { color: #9ecbff; border-color: rgba(122,162,247,.40); background: rgba(122,162,247,.12); }
.oc-stream-bar .progress { margin-left: auto; color: var(--oc-s-faint); font-size: 11px; white-space: nowrap; }
.oc-stream-bar .back {
  flex: 0 0 auto;
  border: 1px solid var(--oc-s-line-strong); border-radius: 5px;
  background: #242424; color: #dcdcdc; font: inherit; font-size: 11px;
  padding: 1px 7px; cursor: pointer; white-space: nowrap;
}
.oc-stream-bar .back:hover { border-color: var(--oc-s-accent); color: var(--oc-s-text); }
.oc-stream-list { flex: 1 1 auto; min-height: 0; min-width: 0; overflow: auto; }
.oc-stream-msg {
  padding: 12px 14px 14px;
  border-bottom: 1px solid var(--oc-s-line);
  min-width: 0;
}
.oc-stream-msg[data-hit="true"] {
  background: rgba(250,204,21,.05);
  box-shadow: inset 2px 0 0 var(--oc-s-hit-text);
}
.oc-stream-head {
  display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px;
  font-size: 11px; color: var(--oc-s-faint);
}
.oc-stream-head .role { color: var(--oc-s-muted); font-weight: 600; }
.oc-stream-head .hit {
  margin-left: auto; color: var(--oc-s-hit-text); border: 1px solid rgba(250,204,21,.35);
  background: rgba(250,204,21,.12); border-radius: 999px; padding: 0 6px; font-size: 10px;
}
.oc-stream-text {
  font-size: 13.5px; line-height: 1.75; white-space: pre-wrap; word-break: break-word;
  overflow-wrap: anywhere; max-width: 100%;
}
.oc-stream-text mark { background: var(--oc-s-hit); color: var(--oc-s-hit-text); border-radius: 2px; }
.oc-stream-user {
  font-size: 13.5px; line-height: 1.75; white-space: pre-wrap; word-break: break-word;
  overflow-wrap: anywhere; max-width: 100%;
  background: var(--oc-s-layer); border-radius: 8px; padding: 10px 12px;
}
.oc-stream-user mark { background: var(--oc-s-hit); color: var(--oc-s-hit-text); border-radius: 2px; }
.oc-stream-tool {
  margin: 6px 0 0; border-radius: 6px; background: #171717;
  border: 1px solid var(--oc-s-line);
  min-width: 0; max-width: 100%;
}
.oc-stream-tool .cap {
  display: flex; align-items: center; gap: 6px; padding: 5px 9px;
  border-bottom: 1px solid var(--oc-s-line); color: var(--oc-s-faint); font-size: 11px;
}
.oc-stream-tool pre {
  margin: 0; padding: 8px 10px; max-width: 100%;
  /* 随面板宽度换行：表格/宽行不再被右侧裁掉，也不需要横向滚动。 */
  white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: hidden;
  font-family: ui-monospace, "JetBrains Mono", "Noto Sans Mono CJK SC", monospace;
  font-size: 12px; line-height: 1.7; color: #b8b8b8;
}
.oc-stream-tool pre mark { background: var(--oc-s-hit); color: var(--oc-s-hit-text); }
.oc-stream-think {
  display: flex; align-items: center; gap: 6px; width: 100%;
  border: 1px dashed var(--oc-s-line-strong); border-radius: 6px;
  background: transparent; color: var(--oc-s-muted); font: inherit; font-size: 12px;
  padding: 4px 9px; cursor: pointer; text-align: left;
}
.oc-stream-think:hover { border-color: var(--oc-s-accent); color: var(--oc-s-text); }
.oc-stream-reasoning {
  font-size: 12.5px; line-height: 1.7; color: var(--oc-s-muted);
  white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; max-width: 100%;
  padding: 6px 2px 0 2px;
}
.oc-stream-sys { font-size: 11.5px; line-height: 1.7; color: var(--oc-s-faint); white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; }
.oc-stream-morebar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }
.oc-stream-morebar .spacer { flex: 1; }
.oc-stream-morebar button {
  border: 1px solid var(--oc-s-line-strong); border-radius: 5px; background: #242424;
  color: #dcdcdc; font: inherit; font-size: 11px; padding: 2px 8px; cursor: pointer;
}
.oc-stream-morebar button:disabled { opacity: .5; cursor: default; }
.oc-stream-expand {
  margin-top: 4px; border: 0; background: transparent; color: var(--oc-s-accent);
  font: inherit; font-size: 11px; cursor: pointer; padding: 0;
}
.oc-stream-empty { padding: 18px 14px; color: var(--oc-s-muted); font-size: 12px; }
.oc-stream-error { padding: 14px; color: #fca5a5; font-size: 12px; }
.oc-stream-error button {
  margin-left: 6px; border: 1px solid var(--oc-s-line-strong); border-radius: 5px;
  background: #242424; color: #dcdcdc; font-size: 11px; padding: 1px 6px; cursor: pointer;
}
.oc-stream-foot {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; border-top: 1px solid var(--oc-s-line);
  background: var(--v2-background-bg-layer-02, #191919);
}
.oc-stream-foot .hint { margin-left: auto; color: var(--oc-s-faint); font-size: 11px; }
`;

const PAGE_SIZE = 40;

export interface StreamViewProps {
  ctx: Context;
  sessionId: string;
  anchorSegmentId: number;
  query: string;
  /** 回放的会话是否就是主区域正在用的那个。 */
  isCurrent: boolean;
  onOpenSession: () => void;
  onExit: () => void;
}

export function StreamView(props: StreamViewProps) {
  const [items, setItems] = createSignal<StreamItem[]>([]);
  const [title, setTitle] = createSignal("");
  const [total, setTotal] = createSignal(0);
  const [offset, setOffset] = createSignal(0);
  const [hasMore, setHasMore] = createSignal(false);
  const [state, setState] = createSignal<LoadState>("idle");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal<"before" | "after" | null>(null);
  const [openThink, setOpenThink] = createSignal<ReadonlySet<number>>(new Set());
  const [fullText, setFullText] = createSignal<ReadonlyMap<number, string>>(new Map());
  const [loadingText, setLoadingText] = createSignal<ReadonlySet<number>>(new Set());

  let listEl: HTMLDivElement | undefined;
  let token = 0;

  const terms = createMemo(() => termsOf(props.query));
  const blocks = createMemo(() => groupByMessage(items()));

  async function fetchPage(params: { offset?: number; anchorSegmentId?: number }) {
    return (await props.ctx.client.rpc(SearchRpc).stream({
      sessionId: props.sessionId,
      limit: PAGE_SIZE,
      ...params,
    })) as StreamOutput;
  }

  function scrollToAnchor() {
    requestAnimationFrame(() => {
      const list = listEl;
      const node = list?.querySelector<HTMLElement>('[data-hit="true"]');
      if (!list || !node) return;
      // 只动流列表自己的 scrollTop：scrollIntoView 会连带滚动外层可滚祖先。
      const listRect = list.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const top = nodeRect.top - listRect.top + list.scrollTop;
      const centered = top - Math.max(0, (list.clientHeight - nodeRect.height) / 2);
      list.scrollTop = Math.max(0, centered);
    });
  }

  async function loadInitial() {
    const my = ++token;
    setState("loading");
    setError("");
    setItems([]);
    setOffset(0);
    setHasMore(false);
    // 切换命中时上一次分页请求可能还在路上；它的 finally 会因 token 变化被丢弃，
    // 这里必须手动复位，否则按钮会一直停在「加载中」。
    setBusy(null);
    setLoadingText(new Set<number>());
    setFullText(new Map<number, string>());
    setOpenThink(new Set<number>());
    try {
      const result = await fetchPage({ anchorSegmentId: props.anchorSegmentId });
      if (my !== token) return;
      setTitle(result.title);
      setTotal(result.total);
      setOffset(result.offset);
      setHasMore(result.hasMore);
      setItems(result.items);
      setState("ready");
      scrollToAnchor();
    } catch (cause) {
      if (my !== token) return;
      setState("error");
      setError(errorText(cause) || "流水加载失败");
    }
  }

  async function loadMore(direction: "before" | "after") {
    if (busy()) return;
    const start = offset();
    const count = items().length;
    const target = direction === "before" ? Math.max(0, start - PAGE_SIZE) : start + count;
    if (direction === "before" && target >= start) return;

    const my = token;
    const beforeHeight = listEl?.scrollHeight ?? 0;
    const beforeTop = listEl?.scrollTop ?? 0;
    setBusy(direction);
    try {
      const result = await fetchPage({ offset: target });
      if (my !== token) return;
      setItems((previous) => mergeItems(previous, result.items));
      if (direction === "before") {
        setOffset(result.offset);
        requestAnimationFrame(() => {
          if (listEl) listEl.scrollTop = beforeTop + (listEl.scrollHeight - beforeHeight);
        });
      } else {
        setHasMore(result.hasMore);
      }
    } catch (cause) {
      if (my === token) setError(errorText(cause) || "加载失败");
    } finally {
      if (my === token) setBusy(null);
    }
  }

  async function toggleText(item: StreamItem) {
    if (fullText().has(item.segmentId)) {
      const next = new Map(fullText());
      next.delete(item.segmentId);
      setFullText(next);
      return;
    }

    // 服务端没截断时，本地已有全文，直接展开。
    if (!item.truncated && item.text.length >= item.length) {
      setFullText(new Map(fullText()).set(item.segmentId, item.text));
      return;
    }

    setLoadingText(new Set(loadingText()).add(item.segmentId));
    // 切换会话后旧响应必须丢弃，否则旧 segmentId 的全文会写进新会话的展开状态。
    const my = token;
    try {
      const result = (await props.ctx.client.rpc(SearchRpc).read({
        segmentId: item.segmentId,
      })) as ReadOutput;
      if (my !== token) return;
      setFullText(new Map(fullText()).set(item.segmentId, result.text ?? ""));
    } catch (cause) {
      if (my !== token) return;
      // 保留截断文本继续可读，但失败必须让用户看见。
      props.ctx.toast.show({
        title: "展开失败",
        description: errorText(cause) || "取全文失败",
        variant: "error",
      });
    } finally {
      if (my === token) {
        const next = new Set(loadingText());
        next.delete(item.segmentId);
        setLoadingText(next);
      }
    }
  }

  function toggleThink(segmentId: number) {
    const next = new Set(openThink());
    if (next.has(segmentId)) next.delete(segmentId);
    else next.add(segmentId);
    setOpenThink(next);
  }

  function textOf(item: StreamItem) {
    return fullText().get(item.segmentId) ?? previewText(item.text).text;
  }

  function clipped(item: StreamItem) {
    const full = fullText().has(item.segmentId);
    if (full) return false;
    return previewText(item.text).clipped || item.truncated;
  }

  /** 「展开本条 / 收起」：普通消息与展开后的思考共用。 */
  function expandControls(item: StreamItem) {
    return (
      <>
        <Show when={clipped(item)}>
          <button
            type="button"
            class="oc-stream-expand"
            disabled={loadingText().has(item.segmentId)}
            onClick={() => void toggleText(item)}
          >
            {loadingText().has(item.segmentId)
              ? "正在取全文…"
              : `展开本条（共 ${item.length} 字）`}
          </button>
        </Show>
        <Show when={fullText().has(item.segmentId)}>
          <button
            type="button"
            class="oc-stream-expand"
            onClick={() => void toggleText(item)}
          >
            收起
          </button>
        </Show>
      </>
    );
  }

  createEffect(
    on(
      () => [props.sessionId, props.anchorSegmentId] as const,
      () => {
        void loadInitial();
      },
      { defer: false },
    ),
  );

  return (
    <div class="oc-stream">
      <div class="oc-stream-bar">
        <button type="button" class="back" onClick={props.onExit} title="返回预览">
          ← 返回预览
        </button>
        <span class="title">{title() || "(无标题会话)"}</span>
        <span class="oc-stream-badge readonly">只读回放</span>
        <Show when={props.isCurrent}>
          <span class="oc-stream-badge current">当前会话</span>
        </Show>
        <span class="progress">
          {total() ? `${offset() + 1}-${offset() + items().length} / ${total()}` : "0 / 0"}
        </span>
      </div>

      <Show
        when={state() !== "error"}
        fallback={
          <div class="oc-stream-error">
            流水加载失败：{error()}
            <button type="button" onClick={() => void loadInitial()}>
              重试
            </button>
          </div>
        }
      >
        <div class="oc-stream-list" ref={(element) => { listEl = element; }}>
          <Show
            when={blocks().length}
            fallback={
              <div class="oc-stream-empty">
                {state() === "loading" ? "正在加载会话流水…" : "这个会话没有可回放的片段。"}
              </div>
            }
          >
            <Show when={error()}>
              <div class="oc-stream-error">
                {error()}
                <button type="button" onClick={() => void loadInitial()}>
                  重新加载
                </button>
              </div>
            </Show>

            <div class="oc-stream-morebar">
              <span class="spacer" />
              <button
                type="button"
                disabled={offset() <= 0 || busy() !== null}
                onClick={() => void loadMore("before")}
              >
                加载更早
              </button>
            </div>

            <For each={blocks()}>
              {(block) => {
                const kind = blockKind(block);
                const hit = block.items.some(
                  (item) => item.segmentId === props.anchorSegmentId,
                );
                return (
                  <section class="oc-stream-msg" data-kind={kind} data-hit={hit ? "true" : undefined}>
                    <div class="oc-stream-head">
                      <span class="role">{roleLabel(kind)}</span>
                      <span>{formatWhen(block.items[0]?.ts ?? 0)}</span>
                      <Show when={hit}>
                        <span class="hit">命中</span>
                      </Show>
                    </div>

                    <For each={block.items}>
                      {(item) => (
                        <Show
                          when={item.kind !== "reasoning"}
                          fallback={
                            <>
                              <button
                                type="button"
                                class="oc-stream-think"
                                onClick={() => toggleThink(item.segmentId)}
                              >
                                {openThink().has(item.segmentId) ? "▾" : "▸"} 思考过程 · {item.length} 字
                              </button>
                              <Show when={openThink().has(item.segmentId)}>
                                <div class="oc-stream-reasoning">
                                  <Highlight text={textOf(item)} terms={terms()} />
                                </div>
                                {expandControls(item)}
                              </Show>
                            </>
                          }
                        >
                          <Show
                            when={item.kind === "tool"}
                            fallback={
                              <Show
                                when={item.kind === "user"}
                                fallback={
                                  <Show
                                    when={item.kind === "assistant"}
                                    fallback={
                                      <div class="oc-stream-sys">
                                        <Highlight text={textOf(item)} terms={terms()} />
                                      </div>
                                    }
                                  >
                                    <div class="oc-stream-text">
                                      <Highlight text={textOf(item)} terms={terms()} />
                                    </div>
                                  </Show>
                                }
                              >
                                <div class="oc-stream-user">
                                  <Highlight text={textOf(item)} terms={terms()} />
                                </div>
                              </Show>
                            }
                          >
                            <div class="oc-stream-tool">
                              <div class="cap">
                                <span>工具输出</span>
                                <span>· {item.length} 字</span>
                              </div>
                              <pre>
                                <Highlight text={textOf(item)} terms={terms()} />
                              </pre>
                            </div>
                          </Show>

                          {expandControls(item)}
                        </Show>
                      )}
                    </For>
                  </section>
                );
              }}
            </For>

            <div class="oc-stream-morebar">
              <span class="spacer" />
              <button
                type="button"
                disabled={!hasMore() || busy() !== null}
                onClick={() => void loadMore("after")}
              >
                {busy() === "after" ? "加载中…" : "加载更多"}
              </button>
            </div>
          </Show>
        </div>
      </Show>

      <div class="oc-stream-foot">
        <props.ctx.ui.Button variant="contrast" size="small" onClick={props.onOpenSession}>
          在标签页打开
        </props.ctx.ui.Button>
        <props.ctx.ui.Button variant="neutral" size="small" onClick={props.onExit}>
          返回预览
        </props.ctx.ui.Button>
        <span class="hint">只读 · 不影响主会话</span>
      </div>
    </div>
  );
}