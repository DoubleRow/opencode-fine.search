import assert from "node:assert/strict";
import test from "node:test";

import {
  blockKind,
  groupByMessage,
  mergeItems,
  nextOffset,
  previewText,
  roleLabel,
} from "../plugin/stream-model.ts";

const item = (segmentId, messageId, kind, text = "x") => ({
  segmentId,
  messageId,
  kind,
  ts: segmentId,
  text,
  truncated: false,
  length: text.length,
});

test("按 messageId 合并相邻片段", () => {
  const blocks = groupByMessage([
    item(1, "m1", "assistant"),
    item(2, "m1", "tool"),
    item(3, "m2", "user"),
    item(4, "m1", "assistant"),
  ]);
  assert.deepEqual(
    blocks.map((block) => [block.messageId, block.items.length]),
    [
      ["m1", 2],
      ["m2", 1],
      ["m1", 1],
    ],
  );
});

test("分页合并去重并按 id 升序", () => {
  const merged = mergeItems(
    [item(3, "m2", "assistant"), item(1, "m1", "user")],
    [item(2, "m1", "assistant"), item(3, "m2", "assistant"), item(4, "m3", "tool")],
  );
  assert.deepEqual(
    merged.map((entry) => entry.segmentId),
    [1, 2, 3, 4],
  );
});

test("消息主角色：用户 > 助手 > 第一条", () => {
  assert.equal(
    blockKind({ messageId: "m", items: [item(1, "m", "tool"), item(2, "m", "user")] }),
    "user",
  );
  assert.equal(
    blockKind({ messageId: "m", items: [item(1, "m", "tool"), item(2, "m", "assistant")] }),
    "assistant",
  );
  assert.equal(blockKind({ messageId: "m", items: [item(1, "m", "tool")] }), "tool");
});

test("角色标签与未知类型回退", () => {
  assert.equal(roleLabel("user"), "用户");
  assert.equal(roleLabel("assistant"), "助手");
  assert.equal(roleLabel("reasoning"), "思考");
  assert.equal(roleLabel("tool"), "工具");
  assert.equal(roleLabel("custom"), "custom");
});

test("显示截断保留前 2000 字", () => {
  const short = previewText("abc");
  assert.equal(short.clipped, false);
  assert.equal(short.text, "abc");

  const long = previewText("x".repeat(5000));
  assert.equal(long.clipped, true);
  assert.equal(long.text.length, 2000);
});

test("翻页偏移：上翻不为负，下翻按条数前进", () => {
  assert.equal(nextOffset(40, 40, "before"), 0);
  assert.equal(nextOffset(10, 40, "before"), 0);
  assert.equal(nextOffset(0, 40, "after"), 40);
  assert.equal(nextOffset(40, 10, "after"), 50);
});