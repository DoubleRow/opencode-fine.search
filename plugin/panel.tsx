/**
 * 详情面板：项目 / 会话任务 / 结果 / 命中原文 / 片段导航。
 *
 * 数据来自 summary 与 read RPC；面板只读，不写会话数据。
 */

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  usePanel,
  type Context,
  type MountedSession,
  type PanelTab,
} from "@opencode/plugin/gui";

import {
  collapseLines,
  formatWhen,
  kindLabel,
  sourceLabel,
  type DetailSelection,
} from "./panel-model";
import { SearchRpc, type ReadOutput, type SummaryOutput } from "./rpc";

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
.oc-detail-label {
  display: flex; align-items: center; gap: 6px; flex: 0 0 auto;
  color: var(--oc-faint); font-size: 11px; letter-spacing: .06em;
}
.oc-detail-label::after { content: ""; flex: 1; height: 1px; background: var(--oc-line); }
.oc-detail-source {
  padding: 1px 6px; border-radius: 999px; border: 1px solid var(--oc-line-strong);
  color: #cfcfcf; background: #232323; letter-spacing: 0; font-size: 10px;
}
.oc-detail-context {
  flex: 0 0 auto; max-height: 34%; overflow: auto;
  padding: 9px 11px; border: 1px solid var(--oc-line); border-radius: 8px;
  background: var(--oc-panel); color: #c7c7c7; line-height: 1.65;
}
.oc-detail-row { display: flex; gap: 8px; }
.oc-detail-row + .oc-detail-row {
  margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--oc-line);
}
.oc-detail-row .k { flex: 0 0 52px; color: var(--oc-faint); font-size: 11px; padding-top: 2px; }
.oc-detail-row .v { flex: 1; min-width: 0; }
.oc-detail-row .v b { color: #ededed; font-weight: 600; }
.oc-detail-hit-wrap { flex: 1 1 auto; min-height: 120px; min-width: 0; display: flex; flex-direction: column; }
.oc-detail-hit {
  flex: 1; min-height: 0; overflow: auto;
  margin-top: 6px; padding: 10px 10px 8px;
  border: 1px solid var(--oc-line); border-radius: 8px; background: #171717;
  color: #b8b8b8; font-family: ui-monospace, "JetBrains Mono", "Noto Sans Mono CJK SC", monospace;
  font-size: 11.5px; line-height: 1.8;
}
.oc-detail-line { display: flex; white-space: pre-wrap; word-break: break-word; }
.oc-detail-line .ln { flex: 0 0 26px; color: #4d4d4d; user-select: none; }
.oc-detail-line .code { min-width: 0; white-space: pre-wrap; word-break: break-word; }
.oc-detail-line mark { background: var(--oc-hit); color: var(--oc-hit-text); border-radius: 2px; padding: 0 1px; }
.oc-detail-nav { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; color: var(--oc-faint); font-size: 11px; }
.oc-detail-nav .spacer { flex: 1; }
.oc-detail-foot {
  flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-top: 1px solid var(--oc-line); background: #191919;
}
.oc-detail-hint { margin-left: auto; color: var(--oc-faint); font-size: 11px; white-space: nowrap; }
.oc-detail-empty, .oc-detail-loading, .oc-detail-error {
  color: var(--oc-muted); font-size: 12px; line-height: 1.7;
}
.oc-detail-error { color: #fca5a5; }
.oc-detail-error button {
  margin-left: 6px; border: 1px solid var(--oc-line-strong); border-radius: 5px;
  background: #242424; color: #dcdcdc; font-size: 11px; padding: 1px 6px; cursor: pointer;
}
`;

interface DetailPanelProps {
  ctx: Context;
  session: MountedSession;
  tab: PanelTab;
  panelKey: string;
  selection: () => DetailSelection | undefined;
  onIndex: (index: number) => void;
}

type LoadState = "idle" | "loading" | "ready" | "error";

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightParts(text: string, terms: string[]) {
  const source = String(text ?? "");
  const words = [...new Set(terms.map((term) => term.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (!words.length) return [{ text: source, hit: false }];

  const pattern = new RegExp(words.map(escapeRegExp).join("|"), "gi");
  const parts = [];
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

function Highlight(props: { text: string; terms: string[] }) {
  return (
    <For each={highlightParts(props.text, props.terms)}>
      {(part) => (part.hit ? <mark>{part.text}</mark> : <>{part.text}</>)}
    </For>
  );
}

export function DetailPanel(props: DetailPanelProps) {
  const panel = usePanel();
  const [summary, setSummary] = createSignal<SummaryOutput | null>(null);
  const [summaryState, setSummaryState] = createSignal<LoadState>("idle");
  const [summaryError, setSummaryError] = createSignal("");
  const [text, setText] = createSignal("");
  const [readState, setReadState] = createSignal<LoadState>("idle");
  const [readError, setReadError] = createSignal("");
  const [expanded, setExpanded] = createSignal(false);

  let summaryToken = 0;
  let readToken = 0;

  const hit = createMemo(() => {
    const selection = props.selection();
    if (!selection || !selection.hits.length) return undefined;
    const index = Math.max(0, Math.min(selection.index, selection.hits.length - 1));
    return selection.hits[index] ?? selection.hits[0];
  });

  const terms = createMemo(() =>
    String(props.selection()?.query ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean),
  );

  const total = createMemo(() => props.selection()?.hits.length ?? 0);
  const index = createMemo(() => {
    const selection = props.selection();
    if (!selection || !selection.hits.length) return 0;
    return Math.max(0, Math.min(selection.index, selection.hits.length - 1));
  });

  const project = createMemo(() => {
    const value = summary()?.project;
    if (value) return value;
    const directory = String(props.session.directory || "").replace(/[\\/]+$/, "");
    return directory.split(/[\\/]/).pop() || "(未知项目)";
  });

  const lines = createMemo(() => collapseLines(text(), expanded()));
  const busy = createMemo(() => summaryState() === "loading" || readState() === "loading");

  async function loadSummary() {
    const token = ++summaryToken;
    setSummary(null);
    setSummaryError("");
    setSummaryState("loading");
    try {
      const result = (await props.ctx.client.rpc(SearchRpc).summary({
        sessionId: props.session.id,
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
    setText("");
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
      () => props.session.id,
      () => {
        void loadSummary();
      },
      { defer: false },
    ),
  );

  createEffect(
    on(
      () => hit()?.segmentId,
      () => {
        setExpanded(false);
        void loadText();
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
    if (!text()) return;
    await props.ctx.system.copy(text());
    props.ctx.toast.show({ title: "已复制原文", variant: "success", icon: "check" });
  }

  function openSession() {
    props.ctx.tabs.open(
      { server: props.session.server.id, id: props.session.id },
      { focus: true },
    );
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
        <span class="count">第 {index() + 1} / 共 {total()} 条</span>
        <button class="x" type="button" aria-label="关闭详情面板" onClick={close}>
          ✕
        </button>
      </div>

      <Show
        when={hit()}
        fallback={
          <div class="oc-detail-body">
            <div class="oc-detail-empty">从会话搜索框选择一条正文命中，面板会自动打开。</div>
          </div>
        }
      >
        {(current) => (
          <>
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

              <div class="oc-detail-label">
                上下文
                <Show when={summary()?.source}>
                  <span class="oc-detail-source">{sourceLabel(summary()!.source)}</span>
                </Show>
              </div>

              <Show
                when={summaryState() !== "loading"}
                fallback={<div class="oc-detail-context oc-detail-loading">正在加载摘要…</div>}
              >
                <Show
                  when={summary()}
                  fallback={
                    <div class="oc-detail-context oc-detail-error">
                      摘要加载失败：{summaryError()}
                      <button type="button" onClick={() => void loadSummary()}>
                        重试
                      </button>
                    </div>
                  }
                >
                  {(value) => (
                    <div class="oc-detail-context">
                      <div class="oc-detail-row">
                        <span class="k">大项目</span>
                        <span class="v">
                          <b>{value().project}</b> · {value().sessionCount} 个会话
                          <Show when={value().lastActive}>
                            <span> · 最近活跃 {formatWhen(value().lastActive)}</span>
                          </Show>
                        </span>
                      </div>
                      <div class="oc-detail-row">
                        <span class="k">当时在做</span>
                        <span class="v">{value().doing}</span>
                      </div>
                      <div class="oc-detail-row">
                        <span class="k">解决</span>
                        <span class="v">{value().solved}</span>
                      </div>
                    </div>
                  )}
                </Show>
              </Show>

              <div class="oc-detail-hit-wrap">
                <div class="oc-detail-label">命中原文</div>
                <Show
                  when={readState() !== "loading"}
                  fallback={<div class="oc-detail-hit oc-detail-loading">正在加载原文…</div>}
                >
                  <Show
                    when={readState() !== "error"}
                    fallback={
                      <div class="oc-detail-hit oc-detail-error">
                        原文加载失败：{readError()}
                        <button type="button" onClick={() => void loadText()}>
                          重试
                        </button>
                      </div>
                    }
                  >
                    <div class="oc-detail-hit">
                      <For each={lines().visible}>
                        {(line, lineIndex) => (
                          <div class="oc-detail-line">
                            <span class="ln">{String(lineIndex() + 1).padStart(2, "0")}</span>
                            <span class="code">
                              <Highlight text={line} terms={terms()} />
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </div>

              <div class="oc-detail-nav">
                <span>
                  片段 {index() + 1} / {total()}
                </span>
                <span class="spacer" />
                <Show when={lines().canExpand}>
                  <props.ctx.ui.Button
                    variant="ghost"
                    size="small"
                    onClick={() => setExpanded((value) => !value)}
                  >
                    {expanded() ? "收起" : `展开全部（共 ${lines().total} 行）`}
                  </props.ctx.ui.Button>
                </Show>
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
              </div>
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
          </>
        )}
      </Show>
    </div>
  );
}