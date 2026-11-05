import assert from "node:assert/strict";
import test from "node:test";

import { contentTitle, installContentSearch } from "../plugin/palette-search.ts";

function fakeClient(sessions, hits) {
  const client = {
    session: {
      async list(input = {}) {
        const query = typeof input.search === "string" ? input.search : "";
        return { data: query ? sessions.filter((s) => s.title.includes(query)) : sessions };
      },
      async get({ sessionID }) {
        return sessions.find((s) => s.id === sessionID);
      },
    },
    rpc() {
      throw new Error("测试应通过 options.search 注入，不应调用真实 RPC");
    },
  };
  return { client, hits };
}

const sessions = [
  { id: "ses_a", title: "原会话 A", time: { updated: 1 }, location: { directory: "/a" } },
  { id: "ses_b", title: "原会话 B", time: { updated: 2 }, location: { directory: "/b" } },
];

const hit = (sessionId, snippet) => ({
  segmentId: 1,
  sessionId,
  messageId: "msg_1",
  kind: "assistant",
  ts: 1,
  title: "",
  directory: "/",
  snippet,
  matchStart: 0,
  matchEnd: 1,
  score: 1,
});

test("正文命中追加到会话搜索结果，选中仍用真实会话 ID", async () => {
  const { client } = fakeClient(sessions);
  const restore = installContentSearch(client, {
    timeoutMs: 1000,
    search: async (query) => ({
      mode: "fts",
      query,
      terms: [query],
      candidates: 1,
      items: [hit("ses_a", "…连接池 的实现…")],
    }),
  });

  const result = await client.session.list({ search: "连接池", limit: 5 });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].id, "ses_a");
  assert.match(result.data[0].title, /^\[正文\] 连接池/);
  assert.match(result.data[0].title, /原会话 A/);
  assert.ok(result.data[0].time.updated > 1);

  restore?.();
  const original = await client.session.list({ search: "连接池" });
  assert.equal(original.data.length, 0);
});

test("无正文命中时退回官方标题搜索", async () => {
  const { client } = fakeClient(sessions);
  installContentSearch(client, {
    timeoutMs: 1000,
    search: async (query) => ({ mode: "fts", query, terms: [query], candidates: 0, items: [] }),
  });

  const result = await client.session.list({ search: "原会话 B" });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].id, "ses_b");
});

test("正文检索失败时退回官方标题搜索，不破坏原生搜索", async () => {
  const { client } = fakeClient(sessions);
  installContentSearch(client, {
    timeoutMs: 1000,
    search: async () => {
      throw new Error("index unavailable");
    },
  });

  const result = await client.session.list({ search: "原会话 A" });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].title, "原会话 A");
});

test("会话 ID 查询与空查询不走正文补丁", async () => {
  const { client } = fakeClient(sessions);
  let calls = 0;
  installContentSearch(client, {
    timeoutMs: 1000,
    search: async (query) => {
      calls += 1;
      return { mode: "fts", query, terms: [query], candidates: 1, items: [hit("ses_a", "x")] };
    },
  });

  await client.session.list({ search: "ses_1234567890abcdefghij" });
  await client.session.list({});
  assert.equal(calls, 0);
});

test("contentTitle 保留查询词与原会话标题", () => {
  const title = contentTitle("连接池", "…a\n b…", "原会话");
  assert.equal(title, "[正文] 连接池 · …a b… · 原会话");
});