/** @jsxImportSource @opentui/solid */
/**
 * oc-search TUI 插件（P2）。
 *
 * 入口：`<leader>f` / 命令面板「全文检索」 / 斜杠 `/finesearch`（别名 `/fs`）。
 * 打开的是独立路由页（见 ./tui-page），不再是 112 列的 xlarge 对话框：
 * 页面占满主内容区，左栏结果、右栏详情，随终端宽高实时重排。
 *
 * 复用 server 插件已注册的 SearchRpc，不重写检索核心。
 */

import { Plugin } from "@opencode/plugin/tui";
import type { Context, Route } from "@opencode/plugin/tui/context";

import { FineSearchPage } from "./tui-page.js";

const PAGE_NAME = "fine.search.page";

/** 搜索页专用标签的惰性会话 id（未发消息不落库）；复用避免每次 /fs 都新开。 */
let searchTabID: string | null = null;
/** 搜索标签对应的「从哪来」；从别的标签重开时沿用。 */
let searchBack: Route | null = null;

export default Plugin.define({
  id: "opencode-fine.search.tui",
  setup(context) {
    const unregister = context.ui.router.register({
      name: PAGE_NAME,
      render: ({ data }) => (
        <FineSearchPage
          context={context}
          initialQuery={typeof data?.query === "string" ? data.query : ""}
          returnTo={asRoute(data?.back) ?? { type: "home" }}
          searchTab={typeof data?.searchTab === "string" ? data.searchTab : undefined}
        />
      ),
    });

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "fine.search.open",
          title: "全文检索（历史会话）",
          group: "全文检索",
          bind: "<leader>f",
          palette: true,
          slash: { name: "finesearch", aliases: ["fs"], arguments: true },
          run: (input?: string) => openPage(context, input),
        },
      ],
      bindings: ["fine.search.open"],
    }));

    return unregister;
  },
});

async function openPage(context: Context, input?: string): Promise<void> {
  const current = context.ui.router.current();
  // 已经在本页时再调 /fs 不再压栈，避免把「返回目标」覆盖成自己。
  if (current.type === "plugin" && current.name === PAGE_NAME) return;
  const query = typeof input === "string" ? input.trim() : "";
  let back = backTarget(context, current);

  // 搜索页单独占一个标签：原会话标签保持原样、任务继续跑。
  // session.new 是惰性的（没发消息不落库），Esc 时把该标签关掉即可。
  let searchTab: string | undefined;
  if (context.ui.tabs.enabled()) {
    const activeNow = activeSession(context);
    const reusable =
      searchTabID !== null && context.ui.tabs.list().some((tab) => tab.sessionID === searchTabID);
    if (reusable && searchTabID) {
      searchTab = searchTabID;
      if (activeNow === searchTabID) back = searchBack ?? back;
      context.ui.tabs.focus(searchTabID);
    } else {
      const before = activeNow;
      try {
        context.keymap.dispatch("session.new");
        searchTab = await waitForNewTab(context, before);
      } catch {
        searchTab = undefined;
      }
      searchTabID = searchTab ?? null;
      searchBack = back;
    }
  }

  context.ui.router.navigate({
    type: "plugin",
    name: PAGE_NAME,
    data: { back, ...(searchTab ? { searchTab } : {}), ...(query ? { query } : {}) },
  });
}

function activeSession(context: Context): string | undefined {
  return context.ui.tabs.list().find((tab) => tab.active)?.sessionID;
}

/** 等 session.new 把新标签切为激活；超时返回 undefined，退回当前标签打开。 */
function waitForNewTab(
  context: Context,
  before: string | undefined,
  timeoutMs = 1000,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      const active = activeSession(context);
      if (active && active !== before) {
        resolve(active);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(undefined);
        return;
      }
      setTimeout(tick, 30);
    };
    setTimeout(tick, 30);
  });
}

/**
 * 记录「从哪来」。开标签页时宿主把会话放在标签里，`router.current()` 仍报 home，
 * 因此优先取当前激活标签的会话 id。
 */
function backTarget(context: Context, current: Route): Route {
  if (context.ui.tabs.enabled()) {
    const active = context.ui.tabs.list().find((tab) => tab.active);
    if (active) return { type: "session", sessionID: active.sessionID };
  }
  return current;
}

/** 路由数据来自持久化/宿主，回读时做一次形状校验。 */
function asRoute(value: unknown): Route | null {
  if (!value || typeof value !== "object") return null;
  const route = value as Record<string, unknown>;
  if (route.type === "home") return { type: "home" };
  if (route.type === "session" && typeof route.sessionID === "string") {
    return { type: "session", sessionID: route.sessionID };
  }
  return null;
}