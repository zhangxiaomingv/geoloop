/**
 * 可见度公示 — 公开榜单聚合层（Profound Index 的轻量版）。
 *
 * 从统一实体层（data/entities.json）聚合每个实体的可见度指标，
 * 供 `GET /api/leaderboard` 与 `/board` 公开页使用。
 *
 * 指标映射（Profound 六维 → 现有数据字段）：
 *  Visibility Score  → 最近一次检测 score（认知 40 + 描述 30 + 来源 30）
 *  认知 Mention       → 最近一次检测是否被 AI 提及
 *  引用 Citation      → 最近一次检测是否有可追溯来源
 *  Share of Voice    → 最近一次场景问句的份额（sceneShares）
 *  Trend             → 最近两次检测 score 差值
 *
 * 口径：结果来自 AI 模型实时回答的客观采样，随时间累积更新。
 * 排除被误判为品牌的问句实体（历史数据里无问号的问句会被 classify 判成 brand）。
 */

import { loadEntities, type EntityProfile } from "./entity.js";

/** 问句误归特征：key 含问句词且足够长 → 不是真实品牌，榜单不收录 */
const QUESTION_LIKE_RE = /什么|怎么|如何|为什么|哪家|哪些|是否|推荐|顾问|介绍/;

export interface LeaderboardRow {
  rank: number;
  key: string;
  name: string;
  kind: "brand" | "site";
  /** 最近一次检测综合分 0-100 */
  score: number;
  verdict: string;
  /** 认知：AI 是否提及 */
  mention: boolean;
  /** 引用：是否有可追溯来源 */
  cited: boolean;
  /** 最近场景份额（%）；无场景数据时为 null */
  sceneShare: number | null;
  scene: string | null;
  /** 趋势：+n / -n / 0；仅一次检测时为 null（无历史） */
  trend: number | null;
  /** 检测次数 */
  checks: number;
  lastAt: string;
}

export interface Leaderboard {
  updatedAt: string;
  total: number;
  engines: string[];
  note: string;
  rows: LeaderboardRow[];
}

function latestCheck(e: EntityProfile) {
  return e.checks.length ? e.checks[e.checks.length - 1] : null;
}

function latestShare(e: EntityProfile): { share: number; scene: string } | null {
  if (!e.sceneShares.length) return null;
  const s = e.sceneShares[e.sceneShares.length - 1];
  return { share: s.share, scene: s.scene };
}

export function buildLeaderboard(): Leaderboard {
  const entities = loadEntities();
  const rows: LeaderboardRow[] = [];

  for (const e of entities) {
    if (e.key.length > 4 && QUESTION_LIKE_RE.test(e.key)) continue; // 问句误归，排除
    if (!e.checks.length) continue;
    const last = latestCheck(e)!;
    const prev = e.checks.length >= 2 ? e.checks[e.checks.length - 2] : null;
    const share = latestShare(e);
    rows.push({
      rank: 0,
      key: e.key,
      name: e.name,
      kind: e.kind,
      score: last.score,
      verdict: last.verdict,
      mention: last.mention,
      cited: last.cited,
      sceneShare: share ? share.share : null,
      scene: share ? share.scene : null,
      trend: prev ? last.score - prev.score : null,
      checks: e.checks.length,
      lastAt: last.at,
    });
  }

  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "zh"));
  rows.forEach((r, i) => (r.rank = i + 1));

  return {
    updatedAt: new Date().toISOString(),
    total: rows.length,
    engines: ["DeepSeek", "豆包"],
    note: "结果来自 AI 模型实时回答的客观采样，随时间累积更新",
    rows,
  };
}
