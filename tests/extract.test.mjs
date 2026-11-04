import assert from "node:assert/strict";
import test from "node:test";

import { extractSegments, scrubDataUris } from "../lib/extract.mjs";

const DATA_URI = `data:image/png;base64,${"A".repeat(200)}`;

function assistantMessage(content, extra = {}) {
  return {
    id: "msg_test",
    sessionId: "ses_test",
    type: "assistant",
    timeCreated: 1_700_000_000_000,
    data: JSON.stringify({
      content,
      snapshot: { secret: "SNAPSHOT_SECRET" },
      model: { id: "some-model" },
      tokens: { input: 1 },
      ...extra,
    }),
  };
}

test("user 消息取 text，并与 displayText 去重", () => {
  const segments = extractSegments({
    type: "user",
    data: JSON.stringify({ text: "连接池怎么实现", metadata: { displayText: "连接池怎么实现" } }),
  });
  assert.deepEqual(segments, [{ kind: "user", text: "连接池怎么实现" }]);
});

test("assistant 文本、思考、工具分别成段", () => {
  const segments = extractSegments(
    assistantMessage([
      { type: "reasoning", text: "先看连接池" },
      { type: "text", text: "连接池用 FTS5" },
      {
        type: "tool",
        name: "shell",
        state: {
          status: "completed",
          input: { command: "rg 连接池 lib" },
          content: [{ type: "text", text: "lib/index-db.mjs:42: 连接池" }],
        },
      },
    ]),
  );

  assert.equal(segments.length, 3);
  assert.equal(segments[0].kind, "reasoning");
  assert.equal(segments[1].kind, "assistant");
  assert.equal(segments[2].kind, "tool");
  assert.match(segments[2].text, /rg 连接池 lib/);
  assert.match(segments[2].text, /index-db\.mjs/);
});

test("write.content、edit.oldString/newString、snapshot 不入库", () => {
  const segments = extractSegments(
    assistantMessage([
      {
        type: "tool",
        name: "write",
        state: {
          status: "completed",
          input: { path: "/tmp/FILE_PATH_OK.md", content: "WRITE_BODY_SECRET" },
          content: [{ type: "text", text: "Created file successfully" }],
        },
      },
      {
        type: "tool",
        name: "edit",
        state: {
          status: "completed",
          input: {
            path: "/tmp/EDIT_PATH_OK.md",
            oldString: "EDIT_OLD_SECRET",
            newString: "EDIT_NEW_SECRET",
          },
          metadata: { patch: "EDIT_PATCH_SECRET" },
        },
      },
    ]),
  );

  const all = segments.map((segment) => segment.text).join("\n");
  assert.match(all, /FILE_PATH_OK\.md/);
  assert.match(all, /EDIT_PATH_OK\.md/);
  assert.doesNotMatch(all, /WRITE_BODY_SECRET/);
  assert.doesNotMatch(all, /EDIT_OLD_SECRET|EDIT_NEW_SECRET|EDIT_PATCH_SECRET/);
  assert.doesNotMatch(all, /SNAPSHOT_SECRET/);
});

test("data URI 不进索引，同段文本保留", () => {
  const segments = extractSegments(
    assistantMessage([
      {
        type: "tool",
        name: "read",
        state: {
          status: "completed",
          input: { path: "/tmp/opencode/image.png" },
          content: [
            { type: "text", text: "Image read successfully" },
            { type: "file", uri: DATA_URI },
          ],
          metadata: { truncated: false },
        },
      },
    ]),
  );

  assert.equal(segments.length, 1);
  assert.match(segments[0].text, /Image read successfully/);
  assert.match(segments[0].text, /image\.png/);
  assert.ok(!segments[0].text.includes("AAAAAAAA"));
  assert.ok(!segments[0].text.includes("data:image"));
});

test("压缩摘要入库，recent 不入库", () => {
  const segments = extractSegments({
    type: "compaction",
    data: JSON.stringify({
      summary: "## Objective\n整理会话",
      recent: [{ text: "RECENT_SECRET" }],
    }),
  });
  assert.deepEqual(segments, [{ kind: "compaction", text: "## Objective\n整理会话" }]);
});

test("scrubDataUris 只替换长 base64，不误伤普通 data: 文本", () => {
  assert.equal(scrubDataUris("data: schema 说明"), "data: schema 说明");
  const scrubbed = scrubDataUris(`前缀 ${DATA_URI} 后缀`);
  assert.match(scrubbed, /\[data URI 已省略\]/);
  assert.ok(!scrubbed.includes("AAAAAAAA"));
});