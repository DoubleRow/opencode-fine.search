import assert from "node:assert/strict";
import test from "node:test";

import {
  DEBOUNCE_MS,
  LIST_WINDOW,
  PAGE_HITS,
  PREVIEW_LINES,
  SEARCH_LIMIT,
  STREAM_PAGE,
  buildRows,
  clipLines,
  dayLabel,
  displayWidth,
  errorText,
  fitText,
  flatten,
  groupBySession,
  highlightParts,
  nextFilter,
  previewView,
  projectName,
  scrollStart,
  sourceLabel,
  stepHits,
  timeLabel,
  tokenLane,
  wrapLine,
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

const item = (overrides = {}) => ({
  segmentId: 1,
  sessionId: "ses_a",
  messageId: "msg_1",
  kind: "assistant",
  ts: Date.now(),
  title: "方案调研",
  directory: "/home/row/文档/opencode项目/opencode-fine.search",
  snippet: "使用 FTS5 trigram 建立索引",
  matchStart: 10,
  matchEnd: 16,
  score: 1,
  ...overrides,
});

test("flatten/fitText 单行化并限宽", () => {
  assert.equal(flatten("  多 行\n 文本 "), "多 行 文本");
  assert.equal(fitText("短"), "短");
  const long = "x".repeat(100);
  const fitted = fitText(long, 20);
  assert.equal(fitted.length, 20);
  assert.ok(fitted.endsWith("…"));
});

test("dayLabel 今天/昨天/月日/年月日", () => {
  const now = Date.parse("2026-11-05T12:00:00");
  assert.equal(dayLabel(Date.parse("2026-11-05T09:00:00"), now), "今天");
  assert.equal(dayLabel(Date.parse("2026-11-04T23:00:00"), now), "昨天");
  assert.equal(dayLabel(Date.parse("2026-10-01T12:00:00"), now), "10-01");
  assert.equal(dayLabel(Date.parse("2025-12-31T12:00:00"), now), "2025-12-31");
});

test("projectName 取末段目录", () => {
  assert.equal(projectName("/home/row/文档/opencode项目/demo"), "demo");
  assert.equal(projectName("C:\\projects\\demo\\"), "demo");
  assert.equal(projectName(""), "未知项目");
});

test("groupBySession 保持首现次序并聚合", () => {
  const groups = groupBySession([
    item({ sessionId: "b", segmentId: 1 }),
    item({ sessionId: "a", segmentId: 2 }),
    item({ sessionId: "b", segmentId: 3 }),
  ]);
  assert.deepEqual(groups.map((g) => g.sessionId), ["b", "a"]);
  assert.deepEqual(groups[0].items.map((i) => i.segmentId), [1, 3]);
});

test("buildRows 生成可跳过的分组头与命中行", () => {
  const rows = buildRows([item(), item({ segmentId: 2, sessionId: "ses_b" })]);
  assert.equal(rows[0].type, "header");
  assert.equal(rows[1].type, "hit");
  assert.ok(rows[1].text.includes("方案调研"));
  assert.equal(rows[2].type, "header");
  assert.equal(rows[3].type, "hit");
});

test("stepHits 跳过分组头并循环", () => {
  const rows = buildRows([
    item(),
    item({ segmentId: 2 }),
    item({ segmentId: 3, sessionId: "ses_b" }),
    item({ segmentId: 4, sessionId: "ses_b" }),
  ]);
  // 行序：header, hit, hit, header, hit, hit
  assert.equal(stepHits(rows, -1, 1), 1); // 进入第一条
  assert.equal(stepHits(rows, -1, -1), 5); // 进入最后一条
  assert.equal(stepHits(rows, 1, 1), 2); // 前进一跳仍在命中
  assert.equal(stepHits(rows, 2, 1), 4); // 跨过分隔头到下一组
  assert.equal(stepHits(rows, 4, -1), 2); // 反向跨组
  assert.equal(stepHits(rows, 5, 1), 1); // 循环到最前
  assert.equal(stepHits(rows, 1, -1), 5); // 循环到最后
  assert.equal(stepHits(rows, 1, 2), 4); // PgDn 语义：两跳（命中 1→2→4，跳过分组头）
  assert.equal(stepHits([], 0, 1), -1); // 空列表
});

test("scrollStart 保证选中可见且尽量少动", () => {
  const visible = LIST_WINDOW;
  const count = 40;
  assert.equal(scrollStart(0, 3, count, visible), 0);
  assert.equal(scrollStart(0, 20, count, visible), 20 - visible + 1);
  assert.equal(scrollStart(10, 5, count, visible), 4); // 向上露一行上下文
  assert.equal(scrollStart(30, 39, count, visible), 26); // prev 越界先收敛，选中已在窗内不动
  assert.equal(scrollStart(999, 0, count, visible), 0); // prev 越界自动收敛
  assert.equal(scrollStart(0, -1, count, visible), 0);
  assert.equal(scrollStart(0, 1, 0, visible), 0);
});

test("nextFilter 循环顺序与 GUI 一致", () => {
  assert.equal(nextFilter("all"), "assistant");
  assert.equal(nextFilter("assistant"), "tool");
  assert.equal(nextFilter("user"), "all"); // 最后一个回到全部
});

test("常量 PAGE_HITS/LIST_WINDOW 为正", () => {
  assert.ok(PAGE_HITS > 0 && LIST_WINDOW > 0);
});

test("displayWidth/wrapLine 按显示宽度硬包", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("连接池"), 6);
  assert.equal(wrapLine("").length, 1); // 空行也要占一行
  const wrapped = wrapLine("一二三四五六七八九十", 10); // 20 当量 ÷ 10 = 2 行
  assert.equal(wrapped.length, 2);
  assert.equal(wrapped.join(""), "一二三四五六七八九十");
  const mixed = wrapLine("ab连接池cd连接池", 10);
  assert.ok(mixed.every((chunk) => displayWidth(chunk) <= 10));
  assert.equal(mixed.join(""), "ab连接池cd连接池");
});

test("highlightParts 与 GUI 同语义：长词优先、大小写不敏感", () => {
  const parts = highlightParts("OpenCode open code 连接池", ["open", "opencode", "连接"]);
  assert.equal(parts[0].text, "OpenCode"); // 长词优先整词命中
  assert.equal(parts[0].hit, true);
  const joined = parts.map((p) => p.text).join("");
  assert.equal(joined, "OpenCode open code 连接池");
  assert.ok(parts.some((p) => p.text === "连接" && p.hit));
  const none = highlightParts("干净文本", []);
  assert.deepEqual(none, [{ text: "干净文本", hit: false }]);
});

test("sourceLabel 徽标", () => {
  assert.equal(sourceLabel("llm"), "LLM");
  assert.equal(sourceLabel("memory"), "记忆");
  assert.equal(sourceLabel("auto"), "自动");
  assert.equal(sourceLabel(""), "自动");
});

test("previewView 固定行数并提示隐藏", () => {
  const text = Array.from({ length: 30 }, (_, i) => `第${i}行`).join("\n");
  const view = previewView(text, 40, PREVIEW_LINES);
  assert.equal(view.hidden, 30 - PREVIEW_LINES);
  const last = view.lines[view.lines.length - 1];
  assert.ok(last.includes(`另有 ${30 - PREVIEW_LINES} 行`));
  assert.ok(view.lines[0].startsWith("第0行"));
});

test("clipLines 限行数并补省略号", () => {
  const lines = clipLines("一\n二\n三\n四", 10, 2);
  assert.equal(lines[0], "一");
  assert.equal(lines[1], "二");
  assert.equal(lines[2], "…");
  assert.deepEqual(clipLines("单行", 10, 3), ["单行"]);
});

test("timeLabel 两位补零", () => {
  assert.equal(timeLabel(new Date(2026, 0, 5, 8, 9).getTime()), "08:09");
});
