import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getMeta,
  getSummary,
  openIndex,
  saveSummary,
  setMeta,
} from "../lib/index-db.mjs";
import {
  autoSummary,
  chooseSummary,
  firstSentences,
  lastSentences,
  parseMemoryOutcome,
  projectName,
} from "../lib/summary.mjs";

test("projectName 兼容 Unix / Windows 路径", () => {
  assert.equal(projectName("/workspace/opencode-fine.search"), "opencode-fine.search");
  assert.equal(projectName("C:\\Users\\demo\\project\\"), "project");
  assert.equal(projectName(""), "(未知项目)");
});

test("autoSummary 用标题做 doing，空标题退回首条用户消息", () => {
  const a = autoSummary({
    title: "连接池排查",
    directory: "/p/alpha",
    lastAssistant: "第一句。第二句！第三句？",
  });
  assert.equal(a.project, "alpha");
  assert.equal(a.doing, "连接池排查");
  assert.equal(a.solved, "第二句！第三句？");

  const b = autoSummary({
    title: "",
    directory: "/p/alpha",
    firstUser: "用户第一条消息",
    lastAssistant: "",
    lastTool: "shell",
  });
  assert.equal(b.doing, "用户第一条消息");
  assert.equal(b.solved, "工具执行完成");
});

test("句子截断保证长度上限", () => {
  assert.equal(firstSentences("一。二。三。", 2), "一。二。");
  assert.equal(lastSentences("一。二。三。", 2), "二。三。");
  assert.ok(lastSentences("x".repeat(300), 2, 100).length <= 100);
});

test("parseMemoryOutcome 只取 Outcome 段前两句", () => {
  const content = `## Objective
做点什么

## Outcome
第一句。第二句。第三句。

## Notes
不应读取`;
  assert.equal(parseMemoryOutcome(content), "第一句。第二句。");
  assert.equal(parseMemoryOutcome("## Objective\n没有结果"), "");
});

test("摘要优先级：LLM > 记忆 > 自动", () => {
  const auto = { project: "P", doing: "自动在做", solved: "自动解决" };
  const storedLlm = {
    source: "llm",
    project: "P",
    doing: "LLM 在做",
    solved: "LLM 解决",
    updatedAt: 1,
  };
  const storedAuto = {
    source: "auto",
    project: "P",
    doing: "旧自动在做",
    solved: "旧自动解决",
    updatedAt: 20,
  };

  assert.equal(
    chooseSummary({ stored: storedLlm, memory: { solved: "记忆解决" }, auto }).source,
    "llm",
  );
  assert.deepEqual(
    chooseSummary({ stored: storedAuto, memory: { solved: "记忆解决" }, auto }),
    { source: "memory", project: "P", doing: "旧自动在做", solved: "记忆解决" },
  );
  assert.deepEqual(
    chooseSummary({ stored: storedAuto, memory: null, auto, sessionUpdated: 10 }),
    { source: "auto", project: "P", doing: "旧自动在做", solved: "旧自动解决" },
  );
  assert.deepEqual(
    chooseSummary({ stored: storedAuto, memory: null, auto, sessionUpdated: 30 }),
    { source: "auto", ...auto },
  );
});

test("summary 表可写入/读取，v1 索引写打开时迁移到 v2", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-summary-test-"));
  const path = join(dir, "index.db");

  try {
    let db = openIndex(path);
    assert.equal(getMeta(db, "schema_version"), "2");
    saveSummary(db, {
      sessionId: "ses_a",
      source: "llm",
      project: "P",
      doing: "在做",
      solved: "解决",
      model: "bailian/auto",
      sourceHash: "hash",
      updatedAt: 123,
    });
    const row = getSummary(db, "ses_a");
    assert.equal(row.source, "llm");
    assert.equal(row.model, "bailian/auto");
    assert.equal(row.sourceHash, "hash");
    db.exec("DROP TABLE summary");
    setMeta(db, "schema_version", "1");
    db.close();

    // 只读打开允许 v1；写打开补齐 summary 表并升级版本。
    db = openIndex(path, { create: false, readOnly: true });
    assert.equal(getMeta(db, "schema_version"), "1");
    db.close();

    db = openIndex(path);
    assert.equal(getMeta(db, "schema_version"), "2");
    assert.equal(getSummary(db, "ses_a"), null);
    saveSummary(db, {
      sessionId: "ses_b",
      source: "auto",
      project: "P",
      doing: "在做",
      solved: "解决",
      updatedAt: 456,
    });
    assert.equal(getSummary(db, "ses_b").source, "auto");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});