/**
 * TUI 搜索对话框的纯逻辑：常量、错误文案、请求代次。
 *
 * 不依赖 DOM / Solid / OpenTUI，node:test 可直接引用（type-stripping）。
 */

/** 输入防抖：低于 GUI 侧感知阈值，避免每键一发 RPC。 */
export const DEBOUNCE_MS = 120;

/** 单次搜索返回条数（服务端上限内，与 GUI 浮层一致）。 */
export const SEARCH_LIMIT = 100;

/** 预览原文固定行数（与 GUI 详情栏口径一致）。 */
export const PREVIEW_LINES = 20;

/** 只读回放分页大小（与 stream RPC 默认一致）。 */
export const STREAM_PAGE = 40;

/** RPC 调用代次：每条异步通道一个 lane，旧请求按编号丢弃。 */
export interface TokenLane {
  /** 领取本次请求的编号（会让此前领取的编号失效）。 */
  begin(): number;
  /** 该编号是否仍是最新请求。 */
  isCurrent(id: number): boolean;
}

export function tokenLane(): TokenLane {
  let token = 0;
  return {
    begin() {
      token += 1;
      return token;
    },
    isCurrent(id: number) {
      return id === token;
    },
  };
}

/** 把未知异常压成一行中文可展示的文本。 */
export function errorText(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || error.name;
  const record = error as Record<string, unknown>;
  const message = record.message ?? record.reason;
  if (typeof message === "string" && message) return message;
  return String(error);
}
