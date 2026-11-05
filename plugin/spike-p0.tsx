/**
 * 搜索入口占位（P0 验证后保留的样式占位，P1 接入正式浮层）。
 *
 * 位置：`session.header` 插槽，位于会话标题 + ⋯ 之后的原生 actions 区。
 * 样式：文字按钮「全文」+ glasses 图标，与原生 Ctrl+F 的放大镜区分。
 * 排序：`order: -1` 让它在原生 Ctrl+F 内联搜索条展开时仍排在最前。
 */

import type { Context } from "@opencode/plugin/gui";

export const SPIKE_CSS = `
.oc-spike-header {
  order: -1;
  display: inline-flex;
  align-items: center;
}
`;

export function SpikeHeaderButton(props: { ctx: Context }) {
  return (
    <span class="oc-spike-header" data-oc-spike="header">
      <props.ctx.ui.Tooltip value="全文检索（占位，P1 接入浮层）">
        <props.ctx.ui.Button
          variant="ghost-muted"
          size="small"
          icon="glasses"
          onClick={() => {
            props.ctx.toast.show({
              title: "全文检索",
              description: "入口占位：P1 将在这里打开搜索浮层。",
              icon: "glasses",
            });
          }}
        >
          全文
        </props.ctx.ui.Button>
      </props.ctx.ui.Tooltip>
    </span>
  );
}