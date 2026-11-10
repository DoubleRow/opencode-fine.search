/**
 * oc-search server 插件。
 *
 * 职责：
 * - 注册 search / read / status RPC；
 * - 惰性拉起 Node sidecar（node:sqlite 需要 Node 运行时）；
 * - 转发请求、重启崩溃的 sidecar、卸载时清理子进程。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";

import {
  SearchRpc,
  type ReadOutput,
  type SearchOutput,
  type StatusOutput,
  type StreamOutput,
  type SummaryOutput,
} from "./rpc.js";

const WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));

/** 单次 RPC 上限：sidecar 挂起时不能让调用方无限等待。 */
const CALL_TIMEOUT_MS = 30_000;

class SidecarError extends Error {
  readonly code: string;

  constructor(message: string, code = "internal") {
    super(message);
    this.name = "SidecarError";
    this.code = code;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveNode(): string {
  const explicit = process.env.OC_SEARCH_NODE;
  if (explicit) return explicit;

  const names = process.platform === "win32" ? ["node.exe"] : ["node"];
  const pathDirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const candidates = [];
  for (const dir of pathDirs) {
    for (const name of names) candidates.push(join(dir, name));
  }
  candidates.push(
    join(homedir(), ".local/bin/node"),
    "/usr/local/bin/node",
    "/usr/bin/node",
    "/opt/homebrew/bin/node",
  );

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  throw new SidecarError(
    "找不到 node 可执行文件；请安装 Node.js，或设置 OC_SEARCH_NODE 指向 node 的绝对路径",
    "node_missing",
  );
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

/** 一个常驻的 worker.mjs 子进程，行式 JSON-RPC。 */
class Sidecar {
  #child: ChildProcessWithoutNullStreams | null = null;
  #pending = new Map<number, Pending>();
  #buffer = "";
  #stderrTail = "";
  #nextId = 1;

  call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new SidecarError("请求已取消", "aborted"));
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#ensure();
    } catch (error) {
      return Promise.reject(error);
    }

    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const onAbort = () => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.cleanup();
        reject(new SidecarError("请求已取消", "aborted"));
      };

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      this.#pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        cleanup,
      });

      signal?.addEventListener("abort", onAbort, { once: true });

      timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#abortHung(method);
      }, CALL_TIMEOUT_MS);
      timer.unref?.();

      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        this.#pending.delete(id);
        cleanup();
        reject(
          new SidecarError(
            `写入 sidecar 失败: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  #ensure(): ChildProcessWithoutNullStreams {
    if (this.#child && this.#child.exitCode === null && !this.#child.killed) {
      return this.#child;
    }

    const node = resolveNode();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(node, [WORKER_PATH, "--serve"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        cwd: process.cwd(),
      });
    } catch (error) {
      throw new SidecarError(
        `无法启动 sidecar: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.#child = child;
    this.#buffer = "";
    this.#stderrTail = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onData(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-1200);
      if (process.env.OC_SEARCH_VERBOSE === "1") process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      this.#failAll(new SidecarError(`sidecar 进程错误: ${error.message}`), child);
    });
    child.on("close", (code) => {
      const detail = this.#stderrTail.trim();
      this.#failAll(
        new SidecarError(
          `sidecar 已退出（code ${code ?? "null"}）${detail ? `: ${detail}` : ""}`,
        ),
        child,
      );
    });

    return child;
  }

  #onData(chunk: string) {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;

      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      const id = Number(message?.id);
      const pending = this.#pending.get(id);
      if (!pending) continue;
      this.#pending.delete(id);

      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(
          new SidecarError(
            String(message?.error?.message || "sidecar 返回错误"),
            String(message?.error?.code || "internal"),
          ),
        );
      }
    }
  }

  #failAll(error: Error, source?: ChildProcessWithoutNullStreams) {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) entry.reject(error);
    // 旧进程的 close 事件不能清掉后来新建的子进程。
    if (!source || this.#child === source) this.#child = null;
  }

  /** 超时视为 sidecar 挂起：终止进程并让下一次调用重新拉起，避免后续请求全部堵死。 */
  #abortHung(method: string) {
    const reason = `sidecar 超过 ${Math.round(CALL_TIMEOUT_MS / 1000)}s 未响应（${method}），已终止并将在下次调用时重建`;
    const child = this.#child;
    this.#child = null;
    this.#failAll(new SidecarError(reason, "timeout"), child ?? undefined);
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // 进程可能已退出。
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // 忽略。
    }
  }

  dispose() {
    const child = this.#child;
    this.#child = null;
    this.#failAll(new SidecarError("sidecar 已关闭", "closed"));
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // 进程可能已退出。
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // 忽略。
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // 忽略。
      }
    }, 2000);
    timer.unref?.();
  }
}

function normalizeSearchInput(input: unknown): Record<string, unknown> {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const query = typeof value.query === "string" ? value.query : "";
  const limit = Number.isInteger(value.limit)
    ? Math.max(1, Math.min(Number(value.limit), 100))
    : 20;
  const offset = Number.isInteger(value.offset) ? Math.max(0, Number(value.offset)) : 0;

  return {
    query,
    limit,
    offset,
    includeReasoning: value.includeReasoning === true,
    includeTools: value.includeTools !== false,
  };
}

function emptySearch(query: string): SearchOutput {
  return { mode: "none", query, terms: [], candidates: 0, items: [] };
}

function unavailableStatus(reason: string, error: string): StatusOutput {
  return {
    ready: false,
    reason,
    dbPath: "",
    sourceDb: "",
    indexedSessions: 0,
    indexedMessages: 0,
    indexedSegments: 0,
    lastSyncAt: 0,
    sourceMtime: 0,
    error,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 就绪类故障要带结构化 reason 交给前端，不能一律压成 index_error。 */
function isNotReady(error: unknown): boolean {
  return error instanceof SidecarError && error.code === "not_ready";
}

export default Plugin.define({
  id: "opencode-fine.search",
  async setup(ctx) {
    const sidecar = new Sidecar();

    const registration = await ctx.rpc.register(SearchRpc, {
      search: async (input, context) => {
        const params = normalizeSearchInput(input);
        if (!String(params.query).trim()) {
          return emptySearch(String(params.query));
        }

        try {
          return await sidecar.call<SearchOutput>("search", params, context.signal);
        } catch (error) {
          if (isNotReady(error)) {
            const reason = messageOf(error);
            return context.error("not_ready", reason, { reason });
          }
          const message = messageOf(error);
          return context.error("index_error", message, { message });
        }
      },

      read: async (input, context) => {
        const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
        const segmentId = Number.isInteger(value.segmentId) ? Number(value.segmentId) : 0;
        if (segmentId <= 0) {
          return context.error("not_found", "segmentId 无效", { segmentId: 0 });
        }

        try {
          return await sidecar.call<ReadOutput>("read", { segmentId }, context.signal);
        } catch (error) {
          if (error instanceof SidecarError && error.code === "not_found") {
            return context.error("not_found", error.message, { segmentId });
          }
          if (isNotReady(error)) {
            const reason = messageOf(error);
            return context.error("not_ready", reason, { reason });
          }
          const message = messageOf(error);
          return context.error("index_error", message, { message });
        }
      },

      stream: async (input, context) => {
        const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
        const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
        if (!sessionId) {
          return context.error("not_found", "sessionId 无效", { sessionId: "" });
        }

        try {
          return await sidecar.call<StreamOutput>(
            "stream",
            {
              sessionId,
              offset: typeof value.offset === "number" ? value.offset : undefined,
              limit: typeof value.limit === "number" ? value.limit : undefined,
              anchorSegmentId:
                typeof value.anchorSegmentId === "number" ? value.anchorSegmentId : undefined,
              maxChars: typeof value.maxChars === "number" ? value.maxChars : undefined,
            },
            context.signal,
          );
        } catch (error) {
          if (error instanceof SidecarError && error.code === "not_found") {
            return context.error("not_found", error.message, { sessionId });
          }
          if (isNotReady(error)) {
            const reason = messageOf(error);
            return context.error("not_ready", reason, { reason });
          }
          const message = messageOf(error);
          return context.error("index_error", message, { message });
        }
      },

      summary: async (input, context) => {
        const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
        const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
        if (!sessionId) {
          return context.error("not_found", "sessionId 无效", { sessionId: "" });
        }

        try {
          return await sidecar.call<SummaryOutput>("summary", { sessionId }, context.signal);
        } catch (error) {
          if (error instanceof SidecarError && error.code === "not_found") {
            return context.error("not_found", error.message, { sessionId });
          }
          if (isNotReady(error)) {
            const reason = messageOf(error);
            return context.error("not_ready", reason, { reason });
          }
          const message = messageOf(error);
          return context.error("index_error", message, { message });
        }
      },

      status: async (_input, context) => {
        try {
          return await sidecar.call<StatusOutput>("status", {}, context.signal);
        } catch (error) {
          const message = messageOf(error);
          return unavailableStatus("sidecar 不可用", message);
        }
      },
    });

    return async () => {
      sidecar.dispose();
      await registration.dispose();
    };
  },
});