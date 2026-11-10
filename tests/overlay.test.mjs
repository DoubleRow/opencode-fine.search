import assert from "node:assert/strict";
import test from "node:test";

import {
  FILTERS,
  cardBox,
  cardOffset,
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

test("↑↓ 在结果上移动，到首尾停住", () => {
  assert.equal(stepIndex(0, 1, 3), 1);
  assert.equal(stepIndex(2, 1, 3), 2); // 末尾不环回
  assert.equal(stepIndex(0, -1, 3), 0); // 开头不环回
  assert.equal(stepIndex(5, 1, 3), 2); // 越界先夹取
  assert.equal(stepIndex(1, 0, 3), 1);
  assert.equal(stepIndex(0, 1, 0), 0);
});
test("浮层卡片避开右侧详情栏", () => {
  // 1440 宽、左栏到 260、详情栏 400：卡片落在 260–1040 之间。
  const docked = cardBox({ viewportWidth: 1440, panelWidth: 400, contentLeft: 260 });
  assert.equal(docked.width, 720);
  assert.equal(docked.left, 290);
  assert.ok(docked.left + docked.width <= 1440 - 400);

  // 面板关掉：可用宽度变大，卡片仍在时间线内居中。
  const free = cardBox({ viewportWidth: 1440, panelWidth: 0, contentLeft: 260 });
  assert.equal(free.width, 720);
  assert.equal(free.left, 490);

  // 窄窗：卡片收窄，右边界不越过面板。
  const narrow = cardBox({ viewportWidth: 1000, panelWidth: 400, contentLeft: 260 });
  assert.equal(narrow.width, 308);
  assert.ok(narrow.left + narrow.width <= 600);
});

test("浮层卡片在极端窄窗下不跑出视口", () => {
  const box = cardBox({ viewportWidth: 600, panelWidth: 300, contentLeft: 200 });
  assert.ok(box.left >= 8);
  assert.ok(box.left + box.width <= 600 - 8);
});

test("位移换算后卡片左边缘落回 cardBox 给的 left", () => {
  const box = cardBox({ viewportWidth: 1854, panelWidth: 400, contentLeft: 260 });
  const offset = cardOffset(box.left, box.width, 1854);
  // left:50% + translate3d(calc(-50% + offset)) 之后的左边缘。
  const finalLeft = 1854 / 2 + offset - box.width / 2;
  assert.ok(Math.abs(finalLeft - box.left) < 0.001);
  assert.ok(finalLeft >= 8);
});
