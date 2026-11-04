/**
 * oc-search GUI 入口。
 *
 * 复用 OpenCode 自带的「会话搜索」对话框（mod+shift+f）与命令面板（mod+k）：
 * 在它们的标题搜索之外，把正文命中作为额外的会话结果追加进去。
 * 具体补丁见 ./palette-search。
 */

import { Command, Plugin, type Context } from "@opencode/plugin/gui";
import { createEffect } from "solid-js";

import { installContentSearch } from "./palette-search";
import { SearchRpc, type StatusOutput } from "./rpc";

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

    // client 会在 server 重启后更换；effect 跟随它重新安装补丁。
    createEffect(() => {
      const client = ctx.client;
      restore?.();
      restore = undefined;
      if (client) restore = installContentSearch(client);
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
    };
  },
});