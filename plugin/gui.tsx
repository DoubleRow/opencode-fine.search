/**
 * oc-search GUI 入口。
 *
 * 1. 复用 OpenCode 自带的「会话搜索」对话框（mod+shift+f）与命令面板（mod+k）：
 *    在标题搜索之外追加正文命中（见 ./palette-search）。
 * 2. 选中命中会话后，自动打开详情面板（见 ./panel）。
 */

import {
  Command,
  Panel,
  Plugin,
  Slot,
  Style,
  type Context,
  type PanelTab,
} from "@opencode/plugin/gui";
import { createEffect, createSignal } from "solid-js";
import { createStore } from "solid-js/store";

import { DETAIL_CSS, DETAIL_KEY_ID, DetailPanel } from "./panel";
import {
  groupHitsBySession,
  pendingFor,
  type DetailSelection,
  type PendingSelection,
} from "./panel-model";
import { installContentSearch } from "./palette-search";
import { SearchRpc, type SearchOutputItem, type StatusOutput } from "./rpc";
import { SPIKE_CSS, SpikeHeaderButton, SpikeOverlay } from "./spike-p0";

function describeStatus(status: StatusOutput): string {
  if (!status.ready) {
    const detail = status.error ? `：${status.error}` : "";
    return `${status.reason || "索引未就绪"}${detail}`;
  }
  return `${status.indexedSessions} 个会话 / ${status.indexedSegments} 个片段`;
}

async function probeStatus(ctx: Context) {
  const toast = ctx.toast.show({
    title: "全文检索",
    description: "正在检查旁路索引…",
    variant: "loading",
    persistent: true,
  });

  try {
    const status = (await ctx.client.rpc(SearchRpc).status({})) as StatusOutput;
    let probe = "";
    if (status.ready) {
      const result = await ctx.client.session.list({ search: "连接池", limit: 3 });
      const first = result?.data?.[0];
      probe = first?.title?.startsWith("[正文]")
        ? "正文搜索已接入原生搜索框"
        : "正文补丁未生效，将退回标题搜索";
    }

    toast.dismiss();
    ctx.toast.show({
      title: status.ready ? "全文检索已就绪" : "全文检索尚未就绪",
      description: probe ? `${describeStatus(status)}；${probe}` : describeStatus(status),
      variant: status.ready && (!probe || probe.startsWith("正文搜索")) ? "success" : "error",
      icon: "magnifying-glass",
    });
  } catch (error) {
    toast.dismiss();
    ctx.toast.show({
      title: "全文检索不可用",
      description: error instanceof Error ? error.message : String(error),
      variant: "error",
    });
  }
}

export default Plugin.define({
  setup(ctx) {
    let restore: (() => void) | undefined;
    const panelKey = `${ctx.id}:${DETAIL_KEY_ID}`;
    const [pending, setPending] = createSignal<Map<string, PendingSelection>>(new Map());
    const [selection, setSelection] = createStore<Record<string, DetailSelection>>({});
    const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function clearPendingTimer(sessionId: string) {
      const timer = pendingTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        pendingTimers.delete(sessionId);
      }
    }

    function recordHits(query: string, items: SearchOutputItem[]) {
      const groups = groupHitsBySession(items);
      if (!groups.size) return;
      const now = Date.now();

      setPending((previous) => {
        const next = new Map(previous);
        for (const [sessionId, hits] of groups) {
          next.set(sessionId, { query, hits, at: now });
        }
        return next;
      });

      for (const sessionId of groups.keys()) {
        clearPendingTimer(sessionId);
        const timer = setTimeout(() => {
          pendingTimers.delete(sessionId);
          setPending((previous) => {
            const entry = previous.get(sessionId);
            if (entry && Date.now() - entry.at <= 5000) return previous;
            const next = new Map(previous);
            next.delete(sessionId);
            return next;
          });
        }, 5100);
        pendingTimers.set(sessionId, timer);
      }
    }

    // client 会在 server 重启后更换；effect 跟随它重新安装补丁。
    createEffect(() => {
      const client = ctx.client;
      restore?.();
      restore = undefined;
      if (client) restore = installContentSearch(client, { onHits: recordHits });
    });

    // 搜索命中后，用户选中对应会话时自动打开详情面板（5 秒窗口）。
    createEffect(() => {
      const current = ctx.sessions.current();
      const entry = current ? pendingFor(pending(), current.id) : undefined;
      if (!current || !entry) return;

      clearPendingTimer(current.id);
      setPending((previous) => {
        const next = new Map(previous);
        next.delete(current.id);
        return next;
      });
      setSelection(current.id, {
        query: entry.query,
        hits: entry.hits,
        at: entry.at,
        index: 0,
      });
      ctx.layout.open(panelKey, current, { tab: "select" });
    });

    ctx.add(Style, DETAIL_CSS);

    // ---- P0 spike：只验证位置与层级，P1 起替换为真实浮层/入口 ----
    ctx.add(Style, SPIKE_CSS);
    ctx.add(Slot, {
      at: "window.bottom",
      render: () => <SpikeOverlay />,
    });
    ctx.add(Slot, {
      at: "session.header",
      order: -1,
      render: () => <SpikeHeaderButton ctx={ctx} />,
    });
    // ---- P0 spike end ----

    const detailTab: PanelTab = {
      id: DETAIL_KEY_ID,
      title: "详情",
      closable: "hover",
    };

    ctx.add(Panel, {
      id: DETAIL_KEY_ID,
      region: "side",
      mobile: { title: "详情", order: 20, kind: "drawer", icon: "magnifying-glass" },
      list: () => [detailTab],
      render: (props) => (
        <DetailPanel
          ctx={ctx}
          session={props.session}
          tab={props.tab}
          panelKey={panelKey}
          selection={() => selection[props.session.id]}
          onIndex={(index) => setSelection(props.session.id, "index", index)}
        />
      ),
    });

    ctx.add(Command, (): Command => ({
      id: "status",
      title: "全文检索：状态与自检",
      description: "检查 sidecar 索引，并验证正文搜索已接入原生会话搜索框",
      keywords: "search index 全文 检索 索引 状态 fine",
      group: "搜索",
      section: "general",
      run: () => probeStatus(ctx),
    }));

    return () => {
      restore?.();
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
    };
  },
});