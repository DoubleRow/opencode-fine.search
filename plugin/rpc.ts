/**
 * oc-search RPC 契约。
 *
 * server 的 ./index.ts 实现它；GUI 用 ctx.client.rpc(SearchRpc) 调用。
 * 只用 JSON Schema，运行时零依赖。
 */

import { Rpc } from "@opencode/plugin/rpc";

const searchItem = {
  type: "object",
  properties: {
    segmentId: { type: "integer" },
    sessionId: { type: "string" },
    messageId: { type: "string" },
    kind: { type: "string" },
    ts: { type: "integer" },
    title: { type: "string" },
    directory: { type: "string" },
    snippet: { type: "string" },
    matchStart: { type: "integer" },
    matchEnd: { type: "integer" },
    score: { type: "number" },
  },
  required: [
    "segmentId",
    "sessionId",
    "messageId",
    "kind",
    "ts",
    "title",
    "directory",
    "snippet",
    "matchStart",
    "matchEnd",
    "score",
  ],
  additionalProperties: false,
} as const;

export const SearchRpc = Rpc.define({
  id: "opencode-fine.search",
  methods: {
    search: {
      input: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer" },
          offset: { type: "integer" },
          includeReasoning: { type: "boolean" },
          includeTools: { type: "boolean" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          mode: { type: "string" },
          query: { type: "string" },
          terms: { type: "array", items: { type: "string" } },
          candidates: { type: "integer" },
          items: { type: "array", items: searchItem },
        },
        required: ["mode", "query", "terms", "candidates", "items"],
        additionalProperties: false,
      },
      errors: {
        not_ready: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
          additionalProperties: false,
        },
        index_error: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    },
    read: {
      input: {
        type: "object",
        properties: { segmentId: { type: "integer" } },
        required: ["segmentId"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          segmentId: { type: "integer" },
          messageId: { type: "string" },
          sessionId: { type: "string" },
          kind: { type: "string" },
          ts: { type: "integer" },
          messageType: { type: "string" },
          title: { type: "string" },
          directory: { type: "string" },
          text: { type: "string" },
        },
        required: [
          "segmentId",
          "messageId",
          "sessionId",
          "kind",
          "ts",
          "messageType",
          "title",
          "directory",
          "text",
        ],
        additionalProperties: false,
      },
      errors: {
        not_found: {
          type: "object",
          properties: { segmentId: { type: "integer" } },
          required: ["segmentId"],
          additionalProperties: false,
        },
        index_error: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    },
    status: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ready: { type: "boolean" },
          reason: { type: "string" },
          dbPath: { type: "string" },
          sourceDb: { type: "string" },
          indexedSessions: { type: "integer" },
          indexedMessages: { type: "integer" },
          indexedSegments: { type: "integer" },
          lastSyncAt: { type: "integer" },
          sourceMtime: { type: "integer" },
          error: { type: "string" },
        },
        required: [
          "ready",
          "reason",
          "dbPath",
          "sourceDb",
          "indexedSessions",
          "indexedMessages",
          "indexedSegments",
          "lastSyncAt",
          "sourceMtime",
          "error",
        ],
        additionalProperties: false,
      },
    },
  },
  events: {},
});

export interface SearchOutputItem {
  segmentId: number;
  sessionId: string;
  messageId: string;
  kind: string;
  ts: number;
  title: string;
  directory: string;
  snippet: string;
  matchStart: number;
  matchEnd: number;
  score: number;
}

export interface SearchOutput {
  mode: string;
  query: string;
  terms: string[];
  candidates: number;
  items: SearchOutputItem[];
}

export interface ReadOutput {
  segmentId: number;
  messageId: string;
  sessionId: string;
  kind: string;
  ts: number;
  messageType: string;
  title: string;
  directory: string;
  text: string;
}

export interface StatusOutput {
  ready: boolean;
  reason: string;
  dbPath: string;
  sourceDb: string;
  indexedSessions: number;
  indexedMessages: number;
  indexedSegments: number;
  lastSyncAt: number;
  sourceMtime: number;
  error: string;
}