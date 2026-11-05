#!/usr/bin/env node
/**
 * 用 OpenCode 的 generate/text 接口批量回填会话摘要。
 *
 * 只读索引 + 只写 summary 表；不写 opencode.db，不写 opencode-mem。
 * 默认跳过已有记忆或 LLM 摘要的会话；--force 重做（相同 source_hash 仍跳过）。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  INDEX_PATH,
  getSummary,
  openIndex,
  saveSummary,
  setMeta,
} from "../lib/index-db.mjs";
import {
  clip,
  fetchMemorySummaries,
  projectName,
} from "../lib/summary.mjs";

const PROMPT_VERSION = "1";
const CALL_INTERVAL_MS = 500;
const RETRY_DELAYS_MS = [2000, 5000];
const CALL_TIMEOUT_MS = 120_000;
const MAX_FIELD = 120;

const USAGE = `用法:
  node scripts/backfill-summary.mjs [--force] [--model provider/model] [--limit N] [--dry-run]

选项:
  --force              重做已有记忆/LLM 摘要的会话（相同 source_hash 仍跳过）
  --model provider/model  指定生成模型，例如 bailian/auto
  --limit N            本次最多处理 N 个会话
  --dry-run            只统计，不调用模型、不写库
  -h, --help           显示帮助

环境变量:
  OC_SEARCH_INDEX      覆盖索引文件路径
  OC_SEARCH_SERVICE    覆盖 service.json 路径
`;

function parseArgs(argv) {
  const opts = {
    force: false,
    model: "",
    limit: 0,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg === "--force") opts.force = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--model") {
      opts.model = String(argv[++i] || "").trim();
      if (!opts.model) throw new Error("--model 需要 provider/model");
    } else if (arg === "--limit") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--limit 需要一个正整数");
      }
      opts.limit = value;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  return opts;
}

function serviceFile() {
  if (process.env.OC_SEARCH_SERVICE) return process.env.OC_SEARCH_SERVICE;
  const state = join(homedir(), ".local/state/opencode/service.json");
  const config = join(homedir(), ".config/opencode/service.json");
  try {
    readFileSync(state);
    return state;
  } catch {
    return config;
  }
}

function serviceConfig() {
  const path = serviceFile();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `无法读取服务凭据 ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const url = String(process.env.OPENCODE_SERVER_URL || parsed.url || "").replace(/\/+$/, "");
  const password = String(parsed.password || "");
  if (!url) throw new Error(`service.json 缺少 url: ${path}`);
  if (!password) throw new Error(`service.json 缺少 password: ${path}`);
  return { url, password };
}

function parseModel(value) {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`--model 需要 provider/model，收到: ${value}`);
  }
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
}

function sourceHash(input) {
  return createHash("sha256")
    .update(`${input.firstUser}\n${input.lastAssistant}\n${input.modelKey}\n${PROMPT_VERSION}`)
    .digest("hex");
}

function segmentText(db, sessionId, kind, direction) {
  const row = db.prepare(
    `SELECT text FROM segment
     WHERE session_id = ? AND kind = ?
     ORDER BY ts ${direction}, id ${direction}
     LIMIT 1`,
  ).get(String(sessionId), String(kind));
  return row ? String(row.text || "") : "";
}

function toolHint(db, sessionId) {
  const row = db.prepare(
    "SELECT count(*) AS count FROM segment WHERE session_id = ? AND kind = 'tool'",
  ).get(String(sessionId));
  return Number(row?.count) > 0 ? "有工具调用（索引未记录工具名）" : "无";
}

function buildPrompt(input) {
  return `你是会话归档器。根据下面的信息，用中文写两句话，只输出 JSON：
{"doing":"...","solved":"..."}

要求：
- doing ≤ 40 字：当时在做什么
- solved ≤ 50 字：最终解决了什么
- 只依据给定内容，不推测、不评价
- 不使用 Markdown，不使用引号以外的标点包裹

项目：${input.project}
会话标题：${input.title}
首条用户消息：${input.firstUser}
最后一条助手回复：${input.lastAssistant}
使用过的工具：${input.tools}`;
}

function parseGeneration(text) {
  let value = String(text ?? "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  if (fenced) value = fenced[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("模型返回不是合法 JSON");
  }

  const doing = typeof parsed?.doing === "string" ? parsed.doing.trim() : "";
  const solved = typeof parsed?.solved === "string" ? parsed.solved.trim() : "";
  if (!doing || !solved) throw new Error("模型返回缺少 doing/solved");
  if (doing.length > MAX_FIELD || solved.length > MAX_FIELD) {
    throw new Error(`模型返回字段超过 ${MAX_FIELD} 字`);
  }
  return { doing, solved };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generate(service, model, prompt) {
  let lastError = "";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      const response = await fetch(`${service.url}/api/experimental/generate/text`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}`,
        },
        body: JSON.stringify({ prompt, model }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      const text = payload?.data?.text ?? payload?.text;
      if (typeof text !== "string" || !text.trim()) {
        throw new Error("生成接口没有返回文本");
      }
      return parseGeneration(text);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError || "生成失败");
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }

  let model;
  try {
    model = parseModel(opts.model);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }

  const db = openIndex(INDEX_PATH);
  const sessions = db
    .prepare("SELECT id, title, directory, time_updated FROM session ORDER BY time_updated DESC")
    .all();
  const memories = await fetchMemorySummaries();

  const candidates = [];
  let skippedMemory = 0;
  let skippedLlm = 0;
  let skippedHash = 0;

  for (const session of sessions) {
    const sessionId = String(session.id);
    const stored = getSummary(db, sessionId);
    const memory = memories.get(sessionId);

    if (!opts.force && memory) {
      skippedMemory += 1;
      continue;
    }
    if (!opts.force && stored?.source === "llm") {
      skippedLlm += 1;
      continue;
    }

    const project = projectName(session.directory);
    const firstUser = clip(segmentText(db, sessionId, "user", "ASC"), 1500);
    const lastAssistant = clip(segmentText(db, sessionId, "assistant", "DESC"), 2500);
    const modelKey = opts.model || "default";
    const hash = sourceHash({ firstUser, lastAssistant, modelKey });

    if (stored?.sourceHash === hash) {
      skippedHash += 1;
      continue;
    }

    candidates.push({
      sessionId,
      project,
      title: String(session.title || "").trim() || "(无标题会话)",
      firstUser: firstUser || "（无用户消息）",
      lastAssistant: lastAssistant || "（无助手正文）",
      tools: toolHint(db, sessionId),
      modelKey,
      hash,
    });
  }

  const selected = opts.limit ? candidates.slice(0, opts.limit) : candidates;
  const skippedTotal = skippedMemory + skippedLlm + skippedHash;

  if (opts.dryRun) {
    process.stdout.write(
      `会话 ${sessions.length} 个，待回填 ${selected.length} 个，跳过 ${skippedTotal} 个` +
        `（记忆 ${skippedMemory} / LLM ${skippedLlm} / 相同 hash ${skippedHash}）\n` +
        `预计调用 ${selected.length} 次${opts.model ? `，模型 ${opts.model}` : ""}\n`,
    );
    db.close();
    return 0;
  }

  const service = serviceConfig();
  let success = 0;
  let failed = 0;
  const startedAt = Date.now();

  for (let index = 0; index < selected.length; index += 1) {
    const item = selected[index];
    try {
      const prompt = buildPrompt(item);
      const result = await generate(service, model, prompt);
      saveSummary(db, {
        sessionId: item.sessionId,
        source: "llm",
        project: item.project,
        doing: result.doing,
        solved: result.solved,
        model: item.modelKey,
        sourceHash: item.hash,
        updatedAt: Date.now(),
      });
      success += 1;
      process.stdout.write(
        `[${index + 1}/${selected.length}] ${item.sessionId} 完成\n`,
      );
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      setMeta(db, "last_error", `backfill ${item.sessionId}: ${message}`);
      process.stderr.write(`[${index + 1}/${selected.length}] ${item.sessionId} 失败: ${message}\n`);
    }

    if (index < selected.length - 1) await sleep(CALL_INTERVAL_MS);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(
    `回填结束：成功 ${success} / 跳过 ${skippedTotal} / 失败 ${failed}，用时 ${elapsed}s\n`,
  );
  db.close();
  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`回填失败: ${error?.message || error}\n`);
    process.exit(1);
  });