/** @jsxImportSource @opentui/solid */
/**
 * oc-search TUI 插件（P2）。
 *
 * 入口：`<leader>f` / 命令面板「全文检索」 / 斜杠 `/finesearch`（别名 `/fs`）。
 * 复用 server 插件已注册的 SearchRpc，不重写检索核心；
 * UI 只是薄壳，纯逻辑在 tui-model.ts。
 *
 * 键位依据官方 docs/cli/keybinds（2026-11-05 实查）：`<leader>f` 未被
 * 默认命令占用；对话框交互键仅在对话框存活期间以高优先级 global 层接管。
 */

import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import { Show, createSignal, onCleanup } from "solid-js";

import {
  SearchRpc,
  type SearchOutput,
  type StatusOutput,
} from "./rpc.js";
import { DEBOUNCE_MS, SEARCH_LIMIT, errorText, tokenLane } from "./tui-model.js";

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

function SearchDialog(props: SearchDialogProps) {
  const theme = props.context.theme;
  const rpc = () => props.context.client.rpc(SearchRpc);

  const [statusLine, setStatusLine] = createSignal("正在确认索引状态…");
  const [resultLine, setResultLine] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const searchLane = tokenLane();
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer);
  });

  async function refreshStatus(): Promise<void> {
    try {
      const status = (await rpc().status({})) as StatusOutput;
      setStatusLine(
        status.ready
          ? `索引就绪 · ${status.indexedSessions} 会话 / ${status.indexedMessages} 消息 / ${status.indexedSegments} 片段`
          : `索引未就绪：${status.reason || status.error || "未知原因"}`,
      );
    } catch (error) {
      setStatusLine(`索引状态获取失败：${errorText(error) || "未知错误"}`);
    }
  }

  async function runSearch(value: string): Promise<void> {
    const query = value.trim();
    if (!query) {
      setResultLine("");
      return;
    }
    const mine = searchLane.begin();
    setBusy(true);
    try {
      const result = (await rpc().search({
        query,
        limit: SEARCH_LIMIT,
        includeReasoning: true,
        includeTools: true,
      })) as SearchOutput;
      if (!searchLane.isCurrent(mine)) return;
      setResultLine(
        `模式 ${result.mode} · 候选 ${result.candidates} · 返回 ${result.items.length}`,
      );
    } catch (error) {
      if (!searchLane.isCurrent(mine)) return;
      setResultLine(`搜索失败：${errorText(error) || "未知错误"}`);
    } finally {
      if (searchLane.isCurrent(mine)) setBusy(false);
    }
  }

  void refreshStatus();

  return (
    <box flexDirection="column" gap={1}>
      <input
        focused
        placeholder="搜索全部会话（输入即查）"
        onInput={(value: string) => {
          if (timer !== undefined) clearTimeout(timer);
          timer = setTimeout(() => void runSearch(value), DEBOUNCE_MS);
        }}
      />
      <Show when={busy()}>
        <text fg={theme.text.muted}>搜索中…</text>
      </Show>
      <text fg={theme.text.muted}>{statusLine()}</text>
      <Show when={resultLine()}>
        <text fg={theme.text.base}>{resultLine()}</text>
      </Show>
      <text fg={theme.text.faint}>Spike：Esc 关闭</text>
    </box>
  );
}
