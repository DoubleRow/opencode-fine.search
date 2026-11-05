import assert from "node:assert/strict";
import test from "node:test";

import { isMac, searchShortcutLabel } from "../plugin/shortcut.ts";

const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

test("macOS 显示 ⌘⇧G", () => {
  assert.equal(isMac(MAC), true);
  assert.equal(searchShortcutLabel(MAC), "⌘⇧G");
  assert.equal(isMac("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"), true);
});

test("Windows / Linux 显示 Ctrl+Shift+G", () => {
  assert.equal(isMac(WINDOWS), false);
  assert.equal(searchShortcutLabel(WINDOWS), "Ctrl+Shift+G");
  assert.equal(isMac(LINUX), false);
  assert.equal(searchShortcutLabel(LINUX), "Ctrl+Shift+G");
});

test("空 UA 不报错，回退到 Ctrl", () => {
  assert.equal(searchShortcutLabel(""), "Ctrl+Shift+G");
  assert.equal(searchShortcutLabel(undefined), "Ctrl+Shift+G");
});