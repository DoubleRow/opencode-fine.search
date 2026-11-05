import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const worker = fileURLToPath(new URL("../plugin/worker.mjs", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [worker, ...args], { encoding: "utf8" });
}

test("未知选项按用法错误返回 2", () => {
  const result = run(["search", "--bogus", "x"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /未知选项/);
});

test("--limit 非正整数返回 2", () => {
  const result = run(["stream", "ses_x", "--limit", "0"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /正整数/);
});

test("--anchor 非正整数返回 2", () => {
  const result = run(["stream", "ses_x", "--anchor", "abc"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /正整数/);
});

test("--help 返回 0 并打印用法", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /用法/);
});
