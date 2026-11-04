/**
 * oc-search GUI 入口（P0 骨架）。
 *
 * 现在只提供标题栏入口与命令，点击后探测 sidecar 索引状态；
 * 搜索弹窗与原文面板在 P1/P2 实现。
 */

import { Command, Plugin, Slot } from "@opencode/plugin/gui";

import { SearchRpc, type StatusOutput } from "./rpc";

function describeStatus(status: StatusOutput): string {
  if (!status.ready) {
    const detail = status.error ? `：${status.error}` : "";
    return `${status.reason || "索引未就绪"}${detail}`;
  }
  return `${status.indexedSessions} 个会话 / ${status.indexedSegments} 个片段`;
}

export default Plugin.define({
  setup(ctx) {
    async function probeStatus(): Promise<void> {
      const toast = ctx.toast.show({
        title: "全文检索",
        description: "正在检查旁路索引…",
        variant: "loading",
        persistent: true,
      });

      try {
        const status = (await ctx.client.rpc(SearchRpc).status({})) as StatusOutput;
        toast.dismiss();
        ctx.toast.show({
          title: status.ready ? "全文检索已就绪" : "全文检索尚未就绪",
          description: describeStatus(status),
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

    // TitlebarItem 在 Linux 会落到左下角 tabs footer（更新提示旁边），
    // 不适合作为搜索入口；改用会话标题行右侧的图标按钮。
    ctx.add(Slot, {
      at: "session.header",
      order: 20,
      render: () => (
        <ctx.ui.Tooltip
          value="会话全文检索"
          keys={ctx.keybinds.keybind(`${ctx.id}.search`)}
        >
          <ctx.ui.IconButton
            icon="magnifying-glass"
            label="会话全文检索"
            size="small"
            variant="ghost"
            onClick={() => void probeStatus()}
          />
        </ctx.ui.Tooltip>
      ),
    });

    ctx.add(Command, (): Command => ({
      id: "search",
      title: "会话全文检索",
      description: "搜索所有 agent 记录过的文字",
      keywords: "search 全文 检索 fine",
      group: "搜索",
      section: "navigation",
      bind: "mod+shift+g",
      featured: true,
      run: () => probeStatus(),
    }));
  },
});