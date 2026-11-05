import assert from "node:assert/strict";
import test from "node:test";

import {
  DEBOUNCE_MS,
  PREVIEW_LINES,
  SEARCH_LIMIT,
  STREAM_PAGE,
  errorText,
  tokenLane,
} from "../plugin/tui-model.ts";

test("常量与 GUI 口径一致", () => {
  assert.equal(DEBOUNCE_MS, 120);
  assert.equal(SEARCH_LIMIT, 100);
  assert.equal(PREVIEW_LINES, 20);
  assert.equal(STREAM_PAGE, 40);
});

test("errorText 压平未知异常为一行文本", () => {
  assert.equal(errorText(new Error("boom")), "boom");
  assert.equal(errorText(new Error()), "Error");
  assert.equal(errorText("直接字符串"), "直接字符串");
  assert.equal(errorText({ message: "带 message" }), "带 message");
  assert.equal(errorText({ reason: "not_ready" }), "not_ready");
  assert.equal(errorText(null), "");
  assert.equal(errorText(undefined), "");
  assert.equal(errorText(404), "404");
});

test("tokenLane 让旧请求判定失效", () => {
  const lane = tokenLane();
  const first = lane.begin();
  assert.ok(lane.isCurrent(first));

  const second = lane.begin();
  assert.ok(second > first);
  assert.ok(lane.isCurrent(second));
  assert.ok(!lane.isCurrent(first)); // 旧代次不再有效
  assert.ok(!lane.isCurrent(0)); // 未领过的编号无效
});
