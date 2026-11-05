import assert from "node:assert/strict";
import test from "node:test";

import {
  FILTERS,
  clampIndex,
  filterItems,
  filterLabel,
  stepIndex,
} from "../plugin/overlay-model.ts";

const hit = (kind, segmentId) => ({
  segmentId,
  sessionId: "ses_a",
  messageId: "m",
  kind,
  ts: 1,
  title: "t",
  directory: "/p/a",
  snippet: "s",
  matchStart: 0,
  matchEnd: 1,
  score: 1,
});

const items = [
  hit("assistant", 1),
  hit("tool", 2),
  hit("user", 3),
  hit("reasoning", 4),
  hit("tool", 5),
];

test("筛选：全部返回副本，其余按 kind 过滤", () => {
  const all = filterItems(items, "all");
  assert.equal(all.length, 5);
  assert.notEqual(all, items);

  assert.deepEqual(
    filterItems(items, "tool").map((item) => item.segmentId),
    [2, 5],
  );
  assert.deepEqual(
    filterItems(items, "user").map((item) => item.segmentId),
    [3],
  );
  assert.deepEqual(filterItems(items, "assistant").map((item) => item.segmentId), [1]);
  assert.deepEqual(filterItems(items, "reasoning").map((item) => item.segmentId), [4]);
});

test("筛选标签覆盖五种类型", () => {
  assert.deepEqual(
    FILTERS.map((option) => option.id),
    ["all", "assistant", "tool", "reasoning", "user"],
  );
  assert.equal(filterLabel("tool"), "工具");
  assert.equal(filterLabel("user"), "提问");
});

test("索引夹取：越界与空列表", () => {
  assert.equal(clampIndex(0, 3), 0);
  assert.equal(clampIndex(2, 3), 2);
  assert.equal(clampIndex(9, 3), 2);
  assert.equal(clampIndex(-4, 3), 0);
  assert.equal(clampIndex(1, 0), 0);
  assert.equal(clampIndex(Number.NaN, 3), 0);
});

test("↑↓ 在结果上循环移动", () => {
  assert.equal(stepIndex(0, 1, 3), 1);
  assert.equal(stepIndex(2, 1, 3), 0);
  assert.equal(stepIndex(0, -1, 3), 2);
  assert.equal(stepIndex(5, 1, 3), 0);
  assert.equal(stepIndex(1, 0, 3), 1);
  assert.equal(stepIndex(0, 1, 0), 0);
});