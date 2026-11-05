/**
 * 会话标题行入口：glasses 图标 + 「全文」，点击开合搜索浮层。
 *
 * 位置：`session.header` 插槽，渲染在会话标题 + ⋯ 之后的原生 actions 区。
 * 样式：文字按钮与原生 Ctrl+F 的放大镜区分。
 * 排序：`order: -1` 让它在原生 Ctrl+F 内联搜索条展开时仍排在最前
 *      （`Slot` 的 `order` 只排序插件插槽，这里靠 CSS order 生效）。
 */

import type { Context } from "@opencode/plugin/gui";

export const HEADER_ENTRY_CSS = `
.oc-search-entry {
  order: -1;
  display: inline-flex;
  align-items: center;
}
`;

export interface HeaderSearchButtonProps {
  ctx: Context;
  open: () => boolean;
  onToggle: () => void;
}

export function HeaderSearchButton(props: HeaderSearchButtonProps) {
  return (
    <span class="oc-search-entry">
      <props.ctx.ui.Tooltip value="全文检索（⌘⇧G）">
        <props.ctx.ui.Button
          variant={props.open() ? "ghost" : "ghost-muted"}
          size="small"
          icon="glasses"
          onClick={props.onToggle}
        >
          全文
        </props.ctx.ui.Button>
      </props.ctx.ui.Tooltip>
    </span>
  );
}