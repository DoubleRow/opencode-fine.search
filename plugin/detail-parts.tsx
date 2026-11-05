/**
 * 详情面板与搜索浮层共用的渲染片段：来源徽标 + 三段上下文 + 命中原文。
 *
 * 折叠行数、类型标签、来源标签等规则都在 ./panel-model，这里只负责渲染。
 * 样式集中在 DETAIL_PARTS_CSS，类名沿用 .oc-detail-*，两个容器都可直接用。
 */

import { For, Show, createMemo, type JSX } from "solid-js";

import { collapseLines, sourceLabel } from "./panel-model";
import type { SummaryOutput } from "./rpc";

export type LoadState = "idle" | "loading" | "ready" | "error";

export const DETAIL_PARTS_CSS = `
.oc-detail-label {
  display: flex; align-items: center; gap: 6px; flex: 0 0 auto;
  color: var(--oc-faint, #6f6f6f); font-size: 11px; letter-spacing: .06em;
}
.oc-detail-label::after {
  content: ""; flex: 1; height: 1px;
  background: var(--oc-line, rgba(255,255,255,.08));
}
.oc-detail-source {
  padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--oc-line-strong, rgba(255,255,255,.14));
  color: #cfcfcf; background: #232323; letter-spacing: 0; font-size: 10px;
}
.oc-detail-context {
  flex: 0 0 auto; max-height: 34%; overflow: auto;
  padding: 9px 11px; border: 1px solid var(--oc-line, rgba(255,255,255,.08));
  border-radius: 8px; background: var(--oc-panel, #202020); color: #c7c7c7; line-height: 1.65;
}
.oc-detail-row { display: flex; gap: 8px; }
.oc-detail-row + .oc-detail-row {
  margin-top: 8px; padding-top: 8px;
  border-top: 1px dashed var(--oc-line, rgba(255,255,255,.08));
}
.oc-detail-row .k { flex: 0 0 52px; color: var(--oc-faint, #6f6f6f); font-size: 11px; padding-top: 2px; }
.oc-detail-row .v { flex: 1; min-width: 0; }
.oc-detail-row .v b { color: #ededed; font-weight: 600; }
.oc-detail-hit-wrap { flex: 1 1 auto; min-height: 120px; min-width: 0; display: flex; flex-direction: column; }
.oc-detail-hit {
  flex: 1; min-height: 0; overflow: auto;
  margin-top: 6px; padding: 10px 10px 8px;
  border: 1px solid var(--oc-line, rgba(255,255,255,.08)); border-radius: 8px; background: #171717;
  color: #b8b8b8; font-family: ui-monospace, "JetBrains Mono", "Noto Sans Mono CJK SC", monospace;
  font-size: 11.5px; line-height: 1.8;
}
.oc-detail-line { display: flex; white-space: pre-wrap; word-break: break-word; }
.oc-detail-line .ln { flex: 0 0 26px; color: #4d4d4d; user-select: none; }
.oc-detail-line .code { min-width: 0; white-space: pre-wrap; word-break: break-word; }
.oc-detail-line mark {
  background: var(--oc-hit, rgba(250,204,21,.28));
  color: var(--oc-hit-text, #fde68a); border-radius: 2px; padding: 0 1px;
}
.oc-detail-more { color: #4d4d4d; font-size: 11px; padding: 4px 0 0 26px; }
.oc-detail-nav {
  display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
  color: var(--oc-faint, #6f6f6f); font-size: 11px;
}
.oc-detail-nav .spacer { flex: 1; }
.oc-detail-empty, .oc-detail-loading, .oc-detail-error {
  color: var(--oc-muted, #9a9a9a); font-size: 12px; line-height: 1.7;
}
.oc-detail-error { color: #fca5a5; }
.oc-detail-context.oc-detail-loading { min-height: 104px; }
.oc-detail-context[data-stale="true"],
.oc-detail-hit[data-stale="true"] {
  opacity: .55;
  transition: opacity 120ms linear;
}
.oc-detail-error button {
  margin-left: 6px; border: 1px solid var(--oc-line-strong, rgba(255,255,255,.14));
  border-radius: 5px; background: #242424; color: #dcdcdc;
  font-size: 11px; padding: 1px 6px; cursor: pointer;
}
`;

export function errorText(error: unknown): string {
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

export function Highlight(props: { text: string; terms: string[] }) {
  return (
    <For each={highlightParts(props.text, props.terms)}>
      {(part) => (part.hit ? <mark>{part.text}</mark> : <>{part.text}</>)}
    </For>
  );
}

export interface SummaryBlockProps {
  summary: SummaryOutput | null;
  state: LoadState;
  error: string;
  onRetry: () => void;
  label?: string;
}

/** 三段上下文 + 来源徽标；加载 / 失败 / 就绪三态。 */
export function SummaryBlock(props: SummaryBlockProps) {
  return (
    <>
      <div class="oc-detail-label">
        {props.label ?? "上下文"}
        <Show when={props.summary?.source}>
          <span class="oc-detail-source">{sourceLabel(props.summary?.source ?? "")}</span>
        </Show>
      </div>

      <Show
        when={props.state !== "error"}
        fallback={
          <div class="oc-detail-context oc-detail-error">
            摘要加载失败：{props.error}
            <button type="button" onClick={props.onRetry}>
              重试
            </button>
          </div>
        }
      >
        <Show
          when={props.summary}
          fallback={<div class="oc-detail-context oc-detail-loading">正在加载摘要…</div>}
        >
          {(value) => (
            <div
              class="oc-detail-context"
              data-stale={props.state === "loading" ? "true" : undefined}
            >
              <div class="oc-detail-row">
                <span class="k">大项目</span>
                <span class="v">
                  <b>{value().project}</b> · {value().sessionCount} 个会话
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
    </>
  );
}

export interface TextBlockProps {
  text: string;
  terms: string[];
  state: LoadState;
  error: string;
  onRetry: () => void;
  label?: string;
  /** 标题行右侧的附加操作，例如「展开为只读回放」。 */
  action?: JSX.Element;
  navStart?: JSX.Element;
  navEnd?: JSX.Element;
}

/** 命中原文：默认 20 行折叠，可展开；底部一行放折叠按钮与自定义导航。 */
export function TextBlock(props: TextBlockProps) {
  const lines = createMemo(() => collapseLines(props.text, false));

  return (
    <div class="oc-detail-hit-wrap">
      <div class="oc-detail-label">
        {props.label ?? "命中原文"}
        <Show when={props.action}>{props.action}</Show>
      </div>

      <Show
        when={props.state !== "error"}
        fallback={
          <div class="oc-detail-hit oc-detail-error">
            原文加载失败：{props.error}
            <button type="button" onClick={props.onRetry}>
              重试
            </button>
          </div>
        }
      >
        <Show
          when={props.text.length > 0}
          fallback={<div class="oc-detail-hit oc-detail-loading">正在加载原文…</div>}
        >
          <div
            class="oc-detail-hit"
            data-stale={props.state === "loading" ? "true" : undefined}
          >
            <For each={lines().visible}>
              {(line, lineIndex) => (
                <div class="oc-detail-line">
                  <span class="ln">{String(lineIndex() + 1).padStart(2, "0")}</span>
                  <span class="code">
                    <Highlight text={line} terms={props.terms} />
                  </span>
                </div>
              )}
            </For>
            <Show when={lines().canExpand}>
              <div class="oc-detail-more">…还有 {lines().hidden} 行，可展开为只读回放</div>
            </Show>
          </div>
        </Show>
      </Show>

      <div class="oc-detail-nav">
        {props.navStart}
        <span class="spacer" />
        {props.navEnd}
      </div>
    </div>
  );
}