import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../bin/oc-search.mjs", import.meta.url));

function run(args) {
  // 参数校验发生在打开数据库之前，这里不需要会话库存在。
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("--limit 非数字按用法错误返回 2", () => {
  const result = run(["向量", "--limit", "abc"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--limit 需要正整数/);
});

test("--limit 0 按用法错误返回 2", () => {
  const result = run(["向量", "--limit", "0"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--limit 需要正整数/);
});

test("选项缺值返回 2 而不是静默回退默认", () => {
  const result = run(["向量", "--dir"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--dir 缺少取值/);
});

test("未知选项返回 2", () => {
  const result = run(["向量", "--bogus"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /未知选项/);
});