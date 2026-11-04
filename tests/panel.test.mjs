import assert from "node:assert/strict";
import test from "node:test";

import {
  collapseLines,
  formatWhen,
  groupHitsBySession,
  kindLabel,
  pendingFor,
  sourceLabel,
} from "../plugin/panel-model.ts";

const hit = (sessionId, segmentId) => ({
  segmentId,
  sessionId,
  messageId: "m",
  kind: "assistant",
  ts: 1,
  title: "t",
  directory: "/p",
  snippet: "s",
  matchStart: 0,
  matchEnd: 1,
  score: 1,
});

test("原文超过 20 行折叠，展开后显示全部", () => {
  const text = Array.from({ length: 21 }, (_, index) => `line ${index + 1}`).join("\n");
  const collapsed = collapseLines(text, false);
  assert.equal(collapsed.total, 21);
  assert.equal(collapsed.visible.length, 20);
  assert.equal(collapsed.canExpand, true);
  assert.equal(collapsed.hidden, 1);

  const expanded = collapseLines(text, true);
  assert.equal(expanded.visible.length, 21);
  assert.equal(expanded.canExpand, true);

  const short = collapseLines("a\nb", false);
  assert.equal(short.visible.length, 2);
  assert.equal(short.canExpand, false);
});

test("自动打开窗口只认 5 秒内的 pending", () => {
  const pending = new Map([["ses_a", { query: "连接池", hits: [hit("ses_a", 1)], at: 1000 }]]);
  assert.ok(pendingFor(pending, "ses_a", 5000));
  assert.equal(pendingFor(pending, "ses_a", 6001), undefined);
  assert.equal(pendingFor(pending, "ses_b", 1000), undefined);
  assert.equal(pendingFor(new Map(), "ses_a", 1000), undefined);
});

test("命中按会话分组并保持顺序", () => {
  const groups = groupHitsBySession([
    hit("ses_a", 1),
    hit("ses_b", 2),
    hit("ses_a", 3),
  ]);
  assert.deepEqual(groups.get("ses_a").map((item) => item.segmentId), [1, 3]);
  assert.deepEqual(groups.get("ses_b").map((item) => item.segmentId), [2]);
});

test("面板标签", () => {
  assert.equal(kindLabel("tool"), "工具输出");
  assert.equal(kindLabel("custom"), "custom");
  assert.equal(sourceLabel("llm"), "LLM");
  assert.equal(sourceLabel("memory"), "记忆");
  assert.equal(sourceLabel("auto"), "自动");
  assert.match(formatWhen(1_700_000_000_000), /^\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatWhen(0), "");
});