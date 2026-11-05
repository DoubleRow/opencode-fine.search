/**
 * 快捷键文案：命令本身注册的是 `mod+shift+g`，宿主按平台映射，
 * 但提示文案要自己判断——macOS 用 ⌘⇧G，Windows / Linux 用 Ctrl+Shift+G。
 */

/** 判定 macOS（含 iPadOS 的桌面模式 UA）。 */
export function isMac(userAgent: string): boolean {
  return /Macintosh|Mac OS X|iPhone|iPad|iPod/i.test(String(userAgent ?? ""));
}

/** 全文检索的快捷键展示文案。 */
export function searchShortcutLabel(userAgent: string): string {
  return isMac(userAgent) ? "⌘⇧G" : "Ctrl+Shift+G";
}