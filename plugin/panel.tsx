/**
 * 详情面板：项目 / 会话任务 / 结果 / 命中原文 / 片段导航。
 *
 * 数据来自 summary 与 read RPC；面板只读，不写会话数据。
 */

import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  usePanel,
  type Context,
  type MountedSession,
  type PanelTab,
} from "@opencode/plugin/gui";

import {
  SummaryBlock,
  TextBlock,
  errorText,
  type LoadState,
} from "./detail-parts";
import {
  formatWhen,
  kindLabel,
  termsOf,
  type DetailSelection,
} from "./panel-model";
import { StreamView } from "./stream";
import {
  SearchRpc,
  type ReadOutput,
  type SearchOutputItem,
  type SummaryOutput,
} from "./rpc";

export const DETAIL_KEY_ID = "detail";

export const DETAIL_CSS = `
.oc-detail {
  --oc-bg: #1c1c1c;
  --oc-panel: #202020;
  --oc-line: rgba(255,255,255,.08);
  --oc-line-strong: rgba(255,255,255,.14);
  --oc-text: #e8e8e8;
  --oc-muted: #9a9a9a;
  --oc-faint: #6f6f6f;
  --oc-accent: #7aa2f7;
  --oc-hit: rgba(250,204,21,.28);
  --oc-hit-text: #fde68a;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--oc-bg);
  border-left: 1px solid var(--oc-line);
  color: var(--oc-text);
  font-size: 12px;
  line-height: 1.55;
  color-scheme: dark;
}
.oc-detail-head {
  flex: 0 0 auto;
  height: 40px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  border-bottom: 1px solid var(--oc-line);
}
.oc-detail-head .title { font-size: 12px; font-weight: 600; letter-spacing: .02em; }
.oc-detail-head .count { color: var(--oc-faint); font-size: 11px; }
.oc-detail-head .x {
  margin-left: auto; border: 0; background: transparent; color: var(--oc-faint);
  font-size: 14px; line-height: 1; cursor: pointer; padding: 4px;
}
.oc-detail-head .x:hover { color: var(--oc-text); }
.oc-detail-body {
  flex: 1; min-height: 0; overflow: hidden;
  padding: 14px 14px 10px;
  display: flex; flex-direction: column; gap: 10px;
}
.oc-detail-meta { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.oc-detail-project {
  display: inline-flex; align-items: center; gap: 6px;
  max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 3px 8px; border: 1px solid var(--oc-line); border-radius: 6px;
  background: #262626; color: #cfcfcf; font-size: 12px;
}
.oc-detail-project .sq {
  width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto;
  background: var(--oc-accent); opacity: .85;
}
.oc-detail-when { margin-left: auto; color: var(--oc-faint); font-size: 11px; white-space: nowrap; }
.oc-detail-session {
  flex: 0 0 auto; font-size: 15px; font-weight: 600; line-height: 1.4; color: #f0f0f0;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.oc-detail-badges { display: flex; gap: 6px; flex-wrap: wrap; flex: 0 0 auto; }
.oc-detail-badge {
  padding: 2px 7px; border: 1px solid var(--oc-line-strong); border-radius: 999px;
  background: #232323; color: #bdbdbd; font-size: 11px; white-space: nowrap;
}
.oc-detail-badge.tool { color: #d7c3ff; border-color: rgba(167,139,250,.35); background: rgba(167,139,250,.10); }
.oc-detail-badge.query mark { background: var(--oc-hit); color: var(--oc-hit-text); border-radius: 2px; padding: 0 2px; }
.oc-detail-foot {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-top: 1px solid var(--oc-line); background: #191919;
}
.oc-detail-hint { margin-left: auto; color: var(--oc-faint); font-size: 11px; white-space: nowrap; }
.oc-detail-views { position: relative; flex: 1 1 auto; min-height: 0; display: flex; }
/* 宿主拖侧栏时会临时把 body 设成 user-select:none，这里显式恢复可选，按钮/导航保持不可选。 */
.oc-detail { user-select: text; -webkit-user-select: text; }
.oc-detail-head, .oc-detail-nav, .oc-detail-foot, .oc-detail-badges,
.oc-detail button { user-select: none; -webkit-user-select: none; }
.oc-detail-view { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.oc-detail-view[data-state="leaving"] {
  position: absolute; inset: 0; pointer-events: none; opacity: 0;
  transform: translateY(-6px) scale(.995);
  transition: opacity 160ms linear, transform 200ms ease;
}
.oc-detail-view[data-state="active"] {
  animation: oc-detail-in 240ms cubic-bezier(.22, 1, .36, 1);
}
@keyframes oc-detail-in {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: none; }
}
.oc-detail-expand {
  margin-left: 8px; border: 0; background: transparent; color: #7aa2f7;
  font: inherit; font-size: 11px; letter-spacing: 0; cursor: pointer; padding: 0;
}
.oc-detail-expand:hover { text-decoration: underline; }
@media (prefers-reduced-motion: reduce) {
  .oc-detail-view[data-state="active"] { animation: none; }
  .oc-detail-view[data-state="leaving"] { transition: none; }
}
`;

interface DetailPanelProps {
  ctx: Context;
  /** 面板所在的会话（只决定 tab 属于哪个 strip），内容由 selection 决定。 */
  session: MountedSession;
  tab: PanelTab;
  panelKey: string;
  selection: () => DetailSelection | undefined;
  onIndex: (index: number) => void;
  /** 打开命中项所属的真实会话。 */
  onOpen: (item: SearchOutputItem) => void;
  /** 是否展示整段会话流水（只读回放）。 */
  streaming: () => boolean;
  /** 从流水退回预览。 */
  onExitStream: () => void;
  /** 把当前命中原文展开为只读回放。 */
  onExpandStream: () => void;
}

export function DetailPanel(props: DetailPanelProps) {
  const panel = usePanel();
  const [summary, setSummary] = createSignal<SummaryOutput | null>(null);
  const [summaryState, setSummaryState] = createSignal<LoadState>("idle");
  const [summaryError, setSummaryError] = createSignal("");
  const [text, setText] = createSignal("");
  const [readState, setReadState] = createSignal<LoadState>("idle");
  const [readError, setReadError] = createSignal("");

  let summaryToken = 0;
  let readToken = 0;

  const hit = createMemo(() => {
    const selection = props.selection();
    if (!selection || !selection.hits.length) return undefined;
    const index = Math.max(0, Math.min(selection.index, selection.hits.length - 1));
    return selection.hits[index] ?? selection.hits[0];
  });

  const terms = createMemo(() => termsOf(props.selection()?.query));

  const total = createMemo(() => props.selection()?.hits.length ?? 0);
  const index = createMemo(() => {
    const selection = props.selection();
    if (!selection || !selection.hits.length) return 0;
    return Math.max(0, Math.min(selection.index, selection.hits.length - 1));
  });

  const project = createMemo(() => {
    const value = summary()?.project;
    if (value) return value;
    const directory = String(hit()?.directory || "").replace(/[\\/]+$/, "");
    return directory.split(/[\\/]/).pop() || "(未知项目)";
  });

  const hitSessionId = createMemo(() => hit()?.sessionId ?? "");

  const busy = createMemo(() => summaryState() === "loading" || readState() === "loading");

  // 面板首次打开时先给骨架，等侧栏展开动画（约 300ms）结束再拉数据，避免动画中换内容。
  const [armed, setArmed] = createSignal(false);

  // 预览 ↔ 流水：保留离场层 240ms 做交叉淡入，避免硬切。
  const [view, setView] = createSignal<"preview" | "stream">("preview");
  const [leaving, setLeaving] = createSignal<"preview" | "stream" | null>(null);
  let viewTimer: ReturnType<typeof setTimeout> | undefined;

  createEffect(
    on(
      () => props.streaming(),
      (value) => {
        const next = value ? "stream" : "preview";
        if (next === view()) return;
        setLeaving(view());
        setView(next);
        clearTimeout(viewTimer);
        viewTimer = setTimeout(() => setLeaving(null), 240);
      },
    ),
  );
  onCleanup(() => clearTimeout(viewTimer));
  onMount(() => {
    const timer = setTimeout(() => setArmed(true), 320);
    onCleanup(() => clearTimeout(timer));
  });

  async function loadSummary() {
    const sessionId = hitSessionId();
    const token = ++summaryToken;
    if (!sessionId) {
      setSummary(null);
      setSummaryError("");
      setSummaryState("idle");
      return;
    }
    setSummaryError("");
    setSummaryState("loading");
    try {
      const result = (await props.ctx.client.rpc(SearchRpc).summary({
        sessionId,
      })) as SummaryOutput | { message?: string };
      if (token !== summaryToken) return;
      if (!result || typeof (result as SummaryOutput).source !== "string") {
        throw new Error((result as { message?: string })?.message || "摘要加载失败");
      }
      setSummary(result as SummaryOutput);
      setSummaryState("ready");
    } catch (error) {
      if (token !== summaryToken) return;
      setSummaryState("error");
      setSummaryError(errorText(error) || "摘要加载失败");
    }
  }

  async function loadText() {
    const current = hit();
    if (!current) {
      setText("");
      setReadState("idle");
      setReadError("");
      return;
    }

    const token = ++readToken;
    setReadError("");
    setReadState("loading");
    try {
      const result = (await props.ctx.client.rpc(SearchRpc).read({
        segmentId: current.segmentId,
      })) as ReadOutput | { message?: string };
      if (token !== readToken) return;
      if (!result || typeof (result as ReadOutput).text !== "string") {
        throw new Error((result as { message?: string })?.message || "原文加载失败");
      }
      setText((result as ReadOutput).text);
      setReadState("ready");
    } catch (error) {
      if (token !== readToken) return;
      setReadState("error");
      setReadError(errorText(error) || "原文加载失败");
    }
  }

  createEffect(
    on(
      () => [hitSessionId(), armed()] as const,
      () => {
        if (armed()) void loadSummary();
      },
      { defer: false },
    ),
  );

  createEffect(
    on(
      () => [hit()?.segmentId, armed()] as const,
      () => {
        if (armed()) void loadText();
      },
      { defer: false },
    ),
  );

  function close() {
    props.ctx.layout.close(props.panelKey, props.session);
  }

  function go(delta: number) {
    const count = total();
    if (count < 2) return;
    props.onIndex((index() + delta + count) % count);
  }

  async function copyText() {
    const value = text();
    if (!value) return;
    try {
      await props.ctx.system.copy(value);
      props.ctx.toast.show({ title: "已复制原文", variant: "success", icon: "check" });
    } catch (error) {
      props.ctx.toast.show({
        title: "复制失败",
        description: errorText(error) || "剪贴板不可用",
        variant: "error",
      });
    }
  }

  function openSession() {
    const current = hit();
    if (current) props.onOpen(current);
  }

  const onKey = (event: KeyboardEvent) => {
    if (!panel.visible()) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    ) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      go(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      go(-1);
    }
  };

  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <div class="oc-detail">
      <div class="oc-detail-head">
        <span class="title">全文检索 · 详情</span>
        <Show when={total() > 1}>
          <span class="count">
            第 {index() + 1} / 共 {total()} 条
          </span>
        </Show>
        <button class="x" type="button" aria-label="关闭详情面板" onClick={close}>
          ✕
        </button>
      </div>

      <Show
        when={hit()}
        fallback={
          <div class="oc-detail-body">
            <div class="oc-detail-empty">
              在搜索浮层里选中一条结果，这里会显示项目、当时在做、解决与命中原文。
            </div>
          </div>
        }
      >
        {(current) => (
          <div class="oc-detail-views">
            <Show when={view() === "preview" || leaving() === "preview"}>
              <div
                class="oc-detail-view"
                data-state={view() === "preview" ? "active" : "leaving"}
              >
                <div class="oc-detail-body">
              <div class="oc-detail-meta">
                <span class="oc-detail-project">
                  <span class="sq" />
                  {project()}
                </span>
                <span class="oc-detail-when">{formatWhen(current().ts)}</span>
              </div>

              <div class="oc-detail-session">{current().title || "(无标题会话)"}</div>

              <div class="oc-detail-badges">
                <span class="oc-detail-badge">{kindLabel(current().kind)}</span>
                <Show when={current().kind === "tool"}>
                  <span class="oc-detail-badge tool">tool</span>
                </Show>
                <Show when={props.selection()?.query}>
                  <span class="oc-detail-badge query">
                    查询：<mark>{props.selection()?.query}</mark>
                  </span>
                </Show>
              </div>

              <SummaryBlock
                summary={summary()}
                state={summaryState()}
                error={summaryError()}
                onRetry={() => void loadSummary()}
              />

              <TextBlock
                text={text()}
                terms={terms()}
                state={readState()}
                error={readError()}
                onRetry={() => void loadText()}
                action={
                  <button
                    type="button"
                    class="oc-detail-expand"
                    onClick={props.onExpandStream}
                  >
                    展开为只读回放 ›
                  </button>
                }
                navStart={
                  <Show when={total() > 1}>
                    <span>
                      片段 {index() + 1} / {total()}
                    </span>
                  </Show>
                }
                navEnd={
                  <>
                    <props.ctx.ui.Button
                      variant="ghost"
                      size="small"
                      disabled={total() < 2}
                      onClick={() => go(-1)}
                    >
                      ↑ 上一条
                    </props.ctx.ui.Button>
                    <props.ctx.ui.Button
                      variant="ghost"
                      size="small"
                      disabled={total() < 2}
                      onClick={() => go(1)}
                    >
                      ↓ 下一条
                    </props.ctx.ui.Button>
                  </>
                }
              />
            </div>

                <div class="oc-detail-foot">
                  <props.ctx.ui.Button variant="contrast" size="small" onClick={openSession}>
                    打开会话
                  </props.ctx.ui.Button>
                  <props.ctx.ui.Button
                    variant="neutral"
                    size="small"
                    disabled={!text()}
                    onClick={() => void copyText()}
                  >
                    复制原文
                  </props.ctx.ui.Button>
                  <span class="oc-detail-hint">{busy() ? "加载中…" : "Esc 关闭"}</span>
                </div>
              </div>
            </Show>

            <Show when={view() === "stream" || leaving() === "stream"}>
              <div
                class="oc-detail-view"
                data-state={view() === "stream" ? "active" : "leaving"}
              >
                <StreamView
                  ctx={props.ctx}
                  sessionId={current().sessionId}
                  anchorSegmentId={current().segmentId}
                  query={props.selection()?.query ?? ""}
                  isCurrent={current().sessionId === props.session.id}
                  onOpenSession={openSession}
                  onExit={props.onExitStream}
                />
              </div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}