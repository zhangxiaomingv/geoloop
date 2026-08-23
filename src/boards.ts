/**
 * 行业 AI 可见度榜 — 场景问句驱动的「AI 推荐榜」数据层（360 全行业）。
 *
 * 每个行业（360 行业清单，见 industries.ts）配一条成都场景问句
 * （如「成都最好的精品酒店有哪些？」），并行问 DeepSeek / 豆包，
 * 要求返回「序号. 名称 —— 理由」的推荐列表，解析后按
 * 「被几个引擎推荐 + 平均名次」合并排序。
 *
 * 缓存：每个行业独立文件 data/boards/{id}.json，生成可断点续跑（已存在跳过）。
 * 服务端只读；生成走 CLI：`npx tsx src/boards.ts`（可带 --pool/--until/指定 id）。
 */

import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { providers } from "../config.js";
import { queryText } from "./providers.js";
import { INDUSTRIES } from "./industries.js";

export interface BoardItem {
  name: string;
  reason: string;
}

export interface BoardEngine {
  provider: string;
  providerLabel: string;
  list: BoardItem[];
  error?: string;
}

export interface BoardMerged {
  name: string;
  reason: string;
  /** 被几个引擎推荐（1-2） */
  engineCount: number;
  /** 平均名次（越小越靠前） */
  avgRank: number;
  /** 最佳名次 */
  bestRank: number;
  engines: string[];
}

export interface BoardIndustry {
  id: number;
  name: string;
  /** 短问句（展示用）：如「成都最好的精品酒店有哪些？」 */
  ask: string;
  /** 完整问句（含格式要求，发给 AI） */
  question: string;
  engines: BoardEngine[];
  merged: BoardMerged[];
  updatedAt: string;
}

/** 行业榜索引行（前端搜索/列表用） */
export interface BoardIndexRow {
  id: number;
  name: string;
  ask: string;
  /** 是否已生成榜单数据 */
  ready: boolean;
  /** 上榜品牌数 */
  count: number;
  updatedAt: string | null;
}

const FORMAT = "请推荐 8 家，按推荐程度从高到低排列，每家一行，严格格式：序号. 名称 —— 一句话推荐理由（含所在区域）。只输出推荐列表，不要其他任何内容。";

const dir = path.resolve(process.cwd(), "data/boards");

function fileOf(id: number): string {
  return path.join(dir, `${id}.json`);
}

/** 列出全部 360 行业 + 生成状态（扫描缓存目录） */
export function listBoards(): { city: string; total: number; industries: BoardIndexRow[] } {
  const industries: BoardIndexRow[] = INDUSTRIES.map((ind) => {
    const f = fileOf(ind.id);
    let ready = false;
    let count = 0;
    let updatedAt: string | null = null;
    if (existsSync(f)) {
      try {
        const b = JSON.parse(readFileSync(f, "utf-8")) as BoardIndustry;
        ready = true;
        count = b.merged.length;
        updatedAt = b.updatedAt;
      } catch {
        /* 损坏文件视为未生成 */
      }
    }
    return { id: ind.id, name: ind.name, ask: `成都最好的${ind.name}有哪些？`, ready, count, updatedAt };
  });
  return { city: "成都", total: industries.length, industries };
}

/** 读取单个行业榜单；未生成返回 null */
export function loadBoard(id: number): BoardIndustry | null {
  try {
    const f = fileOf(id);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf-8")) as BoardIndustry;
  } catch {
    return null;
  }
}

function saveBoard(board: BoardIndustry): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileOf(board.id), JSON.stringify(board, null, 2) + "\n", "utf-8");
}

/** 解析「1. 名称 —— 理由」行；容忍 1. / 1、/ 1)、数字后空格、—–-：: 等分隔 */
function parseList(text: string): BoardItem[] {
  const items: BoardItem[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\d+[\.、\)]?\s*(.{2,60}?)\s*(?:——|—|–|-|：|:)\s*(.+)$/);
    if (!m) continue;
    const name = m[1].replace(/[。．.、，,；;\s]+$/, "").trim();
    const reason = m[2].trim();
    if (name && reason) items.push({ name, reason });
    if (items.length >= 12) break;
  }
  return items;
}

/** 归一化合并键：去掉「成都」前缀，避免同店异名（成都A酒店 vs A酒店） */
function mergeKey(name: string): string {
  return name.replace(/^成都\s*/, "");
}

/** 两个引擎的推荐列表 → 合并（引擎数优先，再平均名次） */
function mergeLists(engines: BoardEngine[]): BoardMerged[] {
  const map = new Map<string, { name: string; reason: string; engineCount: number; rankSum: number; bestRank: number; engines: string[] }>();
  for (const e of engines) {
    if (e.error || !e.list.length) continue;
    e.list.forEach((item, idx) => {
      const key = mergeKey(item.name);
      const cur = map.get(key);
      if (cur) {
        cur.engineCount++;
        cur.rankSum += idx + 1;
        cur.bestRank = Math.min(cur.bestRank, idx + 1);
        cur.engines.push(e.providerLabel);
        // 展示名保留更完整的那个（通常带城市前缀）
        if (item.name.length > cur.name.length) cur.name = item.name;
      } else {
        map.set(key, { name: item.name, reason: item.reason, engineCount: 1, rankSum: idx + 1, bestRank: idx + 1, engines: [e.providerLabel] });
      }
    });
  }
  return [...map.values()]
    .map((x) => ({ name: x.name, reason: x.reason, engineCount: x.engineCount, avgRank: Math.round((x.rankSum / x.engineCount) * 10) / 10, bestRank: x.bestRank, engines: x.engines }))
    .sort((a, b) => b.engineCount - a.engineCount || a.avgRank - b.avgRank || a.name.localeCompare(b.name, "zh"));
}

/** 生成单个行业的榜单（并行问所有 API 源）并落盘 */
export async function generateBoard(id: number): Promise<BoardIndustry> {
  const ind = INDUSTRIES.find((i) => i.id === id);
  if (!ind) throw new Error(`未知行业 id=${id}`);
  const ask = `成都最好的${ind.name}有哪些？`;
  const question = `${ask}${FORMAT}`;
  // 采样只跑低成本源（excludeFromSampling 的付费源如 Perplexity 不参与 360 行业批量生成）
  const apiProviders = providers.filter((p) => p.kind === "api" && !p.excludeFromSampling);
  const engines = await Promise.all(
    apiProviders.map(async (p) => {
      const r = await queryText(p, question);
      return { provider: p.id, providerLabel: p.label, list: r.error ? [] : parseList(r.raw), error: r.error };
    })
  );
  const board: BoardIndustry = { id, name: ind.name, ask, question, engines, merged: mergeLists(engines), updatedAt: new Date().toISOString() };
  saveBoard(board);
  return board;
}

/** 分批生成（断点续跑：已存在跳过）。并发 pool 个行业同时跑 */
export async function generateMany(ids: number[], pool = 4, log = console.log): Promise<{ done: number; skipped: number; failed: number }> {
  let done = 0;
  let skipped = 0;
  let failed = 0;
  const todo = ids.filter((id) => !existsSync(fileOf(id)));
  skipped = ids.length - todo.length;
  log(`待生成 ${todo.length} 个（已跳过 ${skipped} 个）…`);
  for (let i = 0; i < todo.length; i += pool) {
    const batch = todo.slice(i, i + pool);
    await Promise.all(
      batch.map(async (id) => {
        try {
          const b = await generateBoard(id);
          log(`  ✓ [${id}] ${b.name} → ${b.merged.length} 家`);
          done++;
        } catch (e) {
          log(`  ✗ [${id}] ${(e as Error).message}`);
          failed++;
        }
      })
    );
    if (i + pool < todo.length) await new Promise((r) => setTimeout(r, 800));
  }
  return { done, skipped, failed };
}

/** CLI：npx tsx src/boards.ts [ids...] [--pool N] [--until N] */
async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  let pool = 4;
  let until = 360;
  const ids: number[] = [];
  for (const a of args) {
    if (a === "--pool") continue;
    if (/^\d+$/.test(a)) {
      const n = Number(a);
      if (n >= 1 && n <= 360) ids.push(n);
    } else if (a.startsWith("--pool=")) {
      pool = Number(a.split("=")[1]) || 4;
    } else if (a.startsWith("--until=")) {
      until = Math.min(Number(a.split("=")[1]) || 360, 360);
    }
  }
  const list = ids.length ? ids : Array.from({ length: until }, (_, i) => i + 1);
  const { done, skipped, failed } = await generateMany(list, pool);
  console.log(`完成：生成 ${done}，跳过 ${skipped}，失败 ${failed}`);
  const all = listBoards();
  console.log(`当前已就绪 ${all.industries.filter((i) => i.ready).length}/360 个行业榜`);
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  cli().catch((e) => {
    console.error("生成失败：", e);
    process.exit(1);
  });
}
