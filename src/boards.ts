/**
 * 行业 AI 可见度榜 — 场景问句驱动的「AI 推荐榜」数据层。
 *
 * 每个行业配一条成都场景问句（如酒店 →「成都最好的酒店有哪些？」），
 * 并行问 DeepSeek / 豆包，要求返回「序号. 名称 —— 理由」的推荐列表，
 * 解析后按「被几个引擎推荐 + 平均名次」合并排序，缓存到 data/boards.json。
 *
 * 这是 hero 区「行业 AI 可见度榜」弹窗的数据源：
 * 不公开成媒体页，仅作为产品内演示 + 销售线索入口。
 * 生成：`npx tsx src/boards.ts`（写 data/boards.json）；服务端只读缓存。
 */

import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { providers } from "../config.js";
import { queryText } from "./providers.js";

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
  slug: string;
  name: string;
  /** 短问句（展示用）：如「成都最好的酒店有哪些？」 */
  ask: string;
  /** 完整问句（含格式要求，发给 AI） */
  question: string;
  engines: BoardEngine[];
  merged: BoardMerged[];
}

export interface BoardsData {
  city: string;
  updatedAt: string;
  industries: BoardIndustry[];
}

/** 预设行业（成都本地、用户会向 AI 问「哪家好/推荐」的高决策行业，P0 先 8 个） */
export const BOARDS: { slug: string; name: string; ask: string }[] = [
  { slug: "hotel", name: "酒店", ask: "成都最好的酒店有哪些？" },
  { slug: "hotpot", name: "火锅", ask: "成都哪家火锅最好吃？" },
  { slug: "decoration", name: "装修", ask: "成都装修公司哪家好？" },
  { slug: "kaoyan", name: "考研培训", ask: "成都考研培训机构哪家好？" },
  { slug: "dental", name: "口腔", ask: "成都口腔医院哪家好？" },
  { slug: "fullhouse", name: "全屋定制", ask: "成都全屋定制品牌哪家好？" },
  { slug: "wedding", name: "婚纱摄影", ask: "成都婚纱摄影哪家好？" },
  { slug: "beauty", name: "医美", ask: "成都医美机构哪家好？" },
];

const FORMAT = "请推荐 8 家，按推荐程度从高到低排列，每家一行，严格格式：序号. 名称 —— 一句话推荐理由（含所在区域）。只输出推荐列表，不要其他任何内容。";

const file = path.resolve(process.cwd(), "data/boards.json");

export function loadBoards(): BoardsData | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf-8")) as BoardsData;
  } catch {
    return null;
  }
}

export function saveBoards(data: BoardsData): void {
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
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

/** 两个引擎的推荐列表 → 合并（引擎数优先，再平均名次） */
function mergeLists(engines: BoardEngine[]): BoardMerged[] {
  const map = new Map<string, { name: string; reason: string; engineCount: number; rankSum: number; bestRank: number; engines: string[] }>();
  for (const e of engines) {
    if (e.error || !e.list.length) continue;
    e.list.forEach((item, idx) => {
      const cur = map.get(item.name);
      if (cur) {
        cur.engineCount++;
        cur.rankSum += idx + 1;
        cur.bestRank = Math.min(cur.bestRank, idx + 1);
        cur.engines.push(e.providerLabel);
      } else {
        map.set(item.name, { name: item.name, reason: item.reason, engineCount: 1, rankSum: idx + 1, bestRank: idx + 1, engines: [e.providerLabel] });
      }
    });
  }
  return [...map.values()]
    .map((x) => ({ name: x.name, reason: x.reason, engineCount: x.engineCount, avgRank: Math.round((x.rankSum / x.engineCount) * 10) / 10, bestRank: x.bestRank, engines: x.engines }))
    .sort((a, b) => b.engineCount - a.engineCount || a.avgRank - b.avgRank || a.name.localeCompare(b.name, "zh"));
}

/** 生成单个行业的榜单（并行问所有 API 源） */
export async function generateBoard(ind: { slug: string; name: string; ask: string }): Promise<BoardIndustry> {
  const question = `${ind.ask}${FORMAT}`;
  const apiProviders = providers.filter((p) => p.kind === "api");
  const engines = await Promise.all(
    apiProviders.map(async (p) => {
      const r = await queryText(p, question);
      return { provider: p.id, providerLabel: p.label, list: r.error ? [] : parseList(r.raw), error: r.error };
    })
  );
  return { slug: ind.slug, name: ind.name, ask: ind.ask, question, engines, merged: mergeLists(engines) };
}

/** 生成全部预设行业榜单并落盘 */
export async function generateAllBoards(): Promise<BoardsData> {
  const industries: BoardIndustry[] = [];
  for (const ind of BOARDS) {
    industries.push(await generateBoard(ind));
  }
  const data: BoardsData = { city: "成都", updatedAt: new Date().toISOString(), industries };
  saveBoards(data);
  return data;
}

/** CLI：npx tsx src/boards.ts */
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  console.log("生成行业 AI 可见度榜…");
  generateAllBoards()
    .then((d) => {
      for (const ind of d.industries) {
        console.log(`  [${ind.name}] ${ind.merged.length} 家上榜 · 双引擎推荐 ${ind.merged.filter((m) => m.engineCount === 2).length} 家`);
        for (const m of ind.merged.slice(0, 3)) console.log(`    ${m.bestRank}. ${m.name}（${m.engines.join("+")}）`);
      }
      console.log(`已写入 data/boards.json（${d.updatedAt}）`);
    })
    .catch((e) => {
      console.error("生成失败：", e);
      process.exit(1);
    });
}
