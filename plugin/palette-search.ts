/**
 * 把正文命中追加到 OpenCode 原生会话搜索（mod+shift+f）与命令面板（mod+k）。
 *
 * 官方搜索没有插件注入点，所以在 sidecar client 的 `session.list` 上做一层
 * 仅在 `search` 非空时生效的包装：
 * - 先调用 oc-search RPC 取正文命中；
 * - 再用真实的 SessionInfo 克隆出带片段标题的结果；
 * - 选中后仍按真实会话 ID 打开，不写任何会话数据。
 */

import type { OpenCodeClient } from "@opencode/client";

import { SearchRpc, type SearchOutput } from "./rpc.ts";

const PATCH_MARK = Symbol.for("opencode-fine.search.content-search");

export interface ContentSearchOptions {
  /** 最多追加多少个会话（默认 50）。 */
  limit?: number;
  /** 正文检索超时，超时退回官方标题搜索（默认 5000ms）。 */
  timeoutMs?: number;
  /** 测试注入点；默认调用 sidecar RPC。 */
  search?: (query: string, signal?: AbortSignal) => Promise<SearchOutput>;
}

export function contentTitle(query: string, snippet: string, realTitle: string): string {
  const body = String(snippet || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const title = `[正文] ${query} · ${body}`;
  return realTitle ? `${title} · ${realTitle}` : title;
}

function looksLikeSessionId(value: string): boolean {
  return /^ses_[A-Za-z0-9]{20,}$/.test(value);
}

/**
 * 给一个 OpenCodeClient 安装正文搜索补丁。
 * 返回恢复函数；无法安装时返回 undefined。
 */
export function installContentSearch(
  client: OpenCodeClient,
  options: ContentSearchOptions = {},
): (() => void) | undefined {
  const session = (client as unknown as {
    session?: {
      list?: (...args: any[]) => Promise<any>;
      get?: (...args: any[]) => Promise<any>;
    };
  }).session;
  if (!session || typeof session.list !== "function" || typeof session.get !== "function") return;

  const marked = session as unknown as Record<symbol, unknown>;
  if (marked[PATCH_MARK]) return;

  const originalList = session.list.bind(session);
  const originalGet = session.get.bind(session);
  const limit = Math.max(1, Number(options.limit) || 50);
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 5000);
  const search =
    options.search ??
    (async (query: string, signal?: AbortSignal) =>
      (await client.rpc(SearchRpc).search({ query, limit }, { signal })) as SearchOutput);

  const wrapper = async (input?: any, requestOptions?: any): Promise<any> => {
    const query = typeof input?.search === "string" ? input.search.trim() : "";
    if (!query || looksLikeSessionId(query)) return originalList(input, requestOptions);

    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = requestOptions?.signal
        ? AbortSignal.any([requestOptions.signal, timeout])
        : timeout;

      const result = await search(query, signal);
      if (!result.items.length) return originalList(input, requestOptions);

      const requested = Math.max(Number(input?.limit) || limit, limit);
      const pool = await originalList(
        { ...(input ?? {}), search: undefined, limit: Math.max(requested, 200) },
        requestOptions,
      );
      const list = Array.isArray(pool?.data) ? pool.data : [];
      const byId = new Map<string, any>(list.map((item: any) => [item.id, item]));

      const ids = [...new Set(result.items.map((item) => item.sessionId))];
      const missing = ids.filter((id) => !byId.has(id)).slice(0, 10);
      await Promise.all(
        missing.map(async (id) => {
          try {
            byId.set(id, await originalGet({ sessionID: id }, requestOptions));
          } catch {
            // 单个会话取不到时跳过，不影响其它命中。
          }
        }),
      );

      const seen = new Set<string>();
      const hits: any[] = [];
      for (const item of result.items) {
        if (seen.has(item.sessionId)) continue;
        seen.add(item.sessionId);

        const base = byId.get(item.sessionId);
        if (!base) continue;

        hits.push({
          ...base,
          title: contentTitle(query, item.snippet, typeof base.title === "string" ? base.title : ""),
          time: { ...(base.time ?? {}), updated: Date.now() - hits.length },
        });
        if (hits.length >= requested) break;
      }

      if (!hits.length) return originalList(input, requestOptions);
      return { ...pool, data: hits };
    } catch {
      // 索引未就绪、sidecar 超时或请求取消：保持官方标题搜索可用。
      return originalList(input, requestOptions);
    }
  };

  try {
    session.list = wrapper;
    marked[PATCH_MARK] = true;
  } catch {
    return;
  }

  return () => {
    if (session.list === wrapper) {
      session.list = originalList;
      delete marked[PATCH_MARK];
    }
  };
}