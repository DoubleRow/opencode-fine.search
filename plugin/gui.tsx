/**
 * oc-search GUI 入口。
 *
 * 1. 标题行「全文」按钮 / ⌘⇧G 打开非模态搜索浮层（见 ./overlay）：
 *    fixed 定位、不压黑主界面、选中即预览、Enter 打开会话。
 * 2. 原生「会话搜索」的正文补丁默认关闭（见 USE_NATIVE_SEARCH_PATCH），
 *    保留 ./palette-search 与详情面板的自动打开作为回退路径。
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

import { DETAIL_PARTS_CSS } from "./detail-parts";
import { HEADER_ENTRY_CSS, HeaderSearchButton } from "./header-entry";
import { OVERLAY_CSS, SearchOverlay } from "./overlay";
import { STREAM_CSS } from "./stream";
import { DETAIL_CSS, DETAIL_KEY_ID, DetailPanel } from "./panel";
import {
  groupHitsBySession,
  pendingFor,
  selectionFor,
  type DetailSelection,
  type PendingSelection,
} from "./panel-model";
import { installContentSearch } from "./palette-search";
import { SearchRpc, type SearchOutputItem, type StatusOutput } from "./rpc";

/**
 * 是否给原生会话搜索（mod+shift+f）打正文补丁。
 *
 * P1 起正文检索由非模态浮层接管，默认关闭；改成 true 即可恢复
 * `[正文]` 条目与「选中会话自动打开详情面板」这套回退路径。
 */
const USE_NATIVE_SEARCH_PATCH = false;

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
    if (status.ready && USE_NATIVE_SEARCH_PATCH) {
      const result = await ctx.client.session.list({ search: "连接池", limit: 3 });
      const first = result?.data?.[0];
      probe = first?.title?.startsWith("[正文]")
        ? "；正文搜索已接入原生搜索框"
        : "；正文补丁未生效，将退回标题搜索";
    }

    toast.dismiss();
    ctx.toast.show({
      title: status.ready ? "全文检索已就绪" : "全文检索尚未就绪",
      description: status.ready
        ? `${describeStatus(status)}${probe || "；⌘⇧G 打开搜索浮层"}`
        : describeStatus(status),
      variant: status.ready ? "success" : "error",
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
    const [overlayOpen, setOverlayOpen] = createSignal(false);
    /** 侧栏当前是否在「整段流水」模式，键为 `会话id:片段id`。 */
    const [streamKey, setStreamKey] = createSignal<string | null>(null);

    /** 搜索命中项的会话属于哪个 server：已开标签页优先，其次本机 builtin。 */
    function serverForSession(sessionId: string): string | undefined {
      for (const tab of ctx.tabs.list()) {
        if (tab.session?.id === sessionId) return tab.session.server.id;
      }
      const ids = ctx.servers.list();
      const builtin = ids.find((id) => ctx.servers.get(id)?.builtin);
      if (builtin) return builtin;
      const local = ids.find((id) => ctx.servers.get(id)?.local);
      if (local) return local;
      return ctx.sessions.current()?.server.id ?? ids[0];
    }

    /** 详情栏当前是否真的显示在屏幕上（用户可能把侧栏收起了）。 */
    function panelVisible() {
      const host = ctx.sessions.current();
      return host ? ctx.layout.state(panelKey, host) === "visible" : false;
    }

    function openResult(item: SearchOutputItem) {
      const server = serverForSession(item.sessionId);
      if (!server) {
        ctx.toast.show({
          title: "无法打开会话",
          description: "没有找到该会话所属的 server",
          variant: "error",
        });
        return;
      }
      ctx.tabs.open({ server, id: item.sessionId }, { focus: true });
    }

    /**
     * 浮层选中项 → 右侧详情栏。
     *
     * 面板按会话注册，所以挂到「当前会话」的 strip 上，内容由 selection 决定，
     * 即使命中来自别的会话也能预览。首页没有当前会话时返回，浮层只显示结果列表。
     */
    function showDetail(item: SearchOutputItem, query: string) {
      const host = ctx.sessions.current();
      if (!host) return;
      setStreamKey(null);
      setSelection(host.id, selectionFor(query, item));
      if (ctx.layout.state(panelKey, host) !== "visible") {
        ctx.layout.open(panelKey, host, { tab: "select" });
      }
    }

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
      if (client && USE_NATIVE_SEARCH_PATCH) {
        restore = installContentSearch(client, { onHits: recordHits });
      }
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

    /**
     * 浮层里按 Enter / 点结果：
     * 第一次在侧栏展开整段流水，第二次（面板已可见且是同一个片段）才打开标签页。
     */
    function enterResult(item: SearchOutputItem, query: string): "open" | "stream" {
      const host = ctx.sessions.current();
      if (!host) {
        openResult(item);
        return "open";
      }

      const key = `${host.id}:${item.segmentId}`;
      const visible = ctx.layout.state(panelKey, host) === "visible";
      if (visible && streamKey() === key) {
        openResult(item);
        return "open";
      }

      showDetail(item, query);
      setStreamKey(key);
      return "stream";
    }

    ctx.add(Style, DETAIL_PARTS_CSS);
    ctx.add(Style, DETAIL_CSS);

    // ---- 非模态搜索浮层：标题行入口 + window.bottom 常驻挂载 ----
    ctx.add(Style, HEADER_ENTRY_CSS);
    ctx.add(Style, OVERLAY_CSS);
    ctx.add(Style, STREAM_CSS);
    ctx.add(Slot, {
      at: "session.header",
      order: -1,
      render: () => (
        <HeaderSearchButton
          ctx={ctx}
          open={overlayOpen}
          onToggle={() => setOverlayOpen((value) => !value)}
        />
      ),
    });
    ctx.add(Slot, {
      at: "window.bottom",
      render: () => (
        <SearchOverlay
          ctx={ctx}
          open={overlayOpen}
          onClose={() => setOverlayOpen(false)}
          onSelect={showDetail}
          onEnter={enterResult}
          panelVisible={panelVisible}
        />
      ),
    });

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
          onOpen={openResult}
          streaming={() => {
            const hit = selection[props.session.id]?.hits[0];
            return !!hit && streamKey() === `${props.session.id}:${hit.segmentId}`;
          }}
          onExitStream={() => setStreamKey(null)}
        />
      ),
    });

    ctx.add(Command, (): Command => ({
      id: "search",
      title: "全文检索：搜索全部会话",
      description: "打开非模态搜索浮层，主界面保持可见",
      keywords: "search find 全文 检索 索引 fine overlay",
      group: "搜索",
      section: "general",
      bind: "mod+shift+g",
      featured: true,
      run: () => {
        setOverlayOpen((value) => !value);
      },
    }));

    ctx.add(Command, (): Command => ({
      id: "status",
      title: "全文检索：状态与自检",
      description: "检查 sidecar 索引与全文检索状态",
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