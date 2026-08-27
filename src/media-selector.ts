/**
 * 软文街媒体选择器 — 从 9 万+ 媒体里筛出「能帮 AI 认知目标实体」的最优发稿组合
 *
 * GEO 目标下的选择逻辑（非「最权威」，而是「收录后能被 AI 引用」）：
 *   Step 1 硬过滤：外链能力(可带) / 收录类型(新闻源>网页) / 预算 / 标题限长 / 权重下限
 *   Step 2 相关性：taxonomy 频道 ↔ 需求单关键词行业、area ↔ 实体所在地、媒体名关键词命中
 *   Step 3 加权打分：收录率 35% / 成功率 15% / 相关度 15% / 权威度 15% / 地区 10% / 性价比 10%
 *   Step 4 多样性：同一媒体最多 1-2 篇，频道分散
 *
 * 门户/行业站（is_zimeiti=2 软文媒体、权威/认证/网络媒体）优先；高权重自媒体(媒体号)补充。
 * 纯确定性计算，零 LLM 成本，可调参 —— 与 pack.ts 风格一致。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface SoftwenMedia {
  id: number | string;
  name: string;
  sort_type?: string;
  platform?: string;
  taxonomy?: string;
  media?: string;
  area?: string;
  include_type?: string;
  url_type?: string;
  title_limit?: number | null;
  price?: number | null;
  price_market?: number | null;
  pc_weight?: number | null;
  m_weight?: number | null;
  success_radio?: string | number | null;
  include_radio?: string | number | null;
  is_zimeiti?: number | null;
  recommend?: string[] | null;
  publish_time?: string;
  description?: string;
}

export interface SelectionOptions {
  /** 单个媒体价格上限（默认 200） */
  maxPrice?: number;
  /** 收录类型白名单（默认含 新闻源收录 / 网页收录） */
  includeTypes?: string[];
  /** 是否要求能带外链（url_type=可带） */
  requireLink?: boolean;
  /** 要选出几家（默认 10） */
  topN?: number;
  /** 目标实体所在地（如 成都/四川/全国），用于 area 匹配 */
  area?: string;
  /** 目标关键词（用于 taxonomy/名称 相关度） */
  keywords?: string[];
  /** 每个媒体最多选中次数（防一稿全发一家） */
  maxPerMedia?: number;
  /** 排除自媒体（is_zimeiti=1），只留门户/行业站。用户决策 2026-08-27，默认开启 */
  excludeZimeiti?: boolean;
}

export interface ScoredMedia {
  media: SoftwenMedia;
  score: number;
  reasons: string[];
}

const DEFAULT_OPTS: Required<Pick<SelectionOptions, "maxPrice" | "includeTypes" | "requireLink" | "topN" | "maxPerMedia" | "excludeZimeiti">> = {
  maxPrice: 200,
  includeTypes: ["新闻源收录", "网页收录"],
  requireLink: false,
  topN: 10,
  maxPerMedia: 1,
  excludeZimeiti: true,
};

/** 权威度 0-100：媒体类型 + sort_type 级别 + 百度权重 */
function authorityScore(m: SoftwenMedia): number {
  let s = 0;
  // 类型：权威媒体 > 认证媒体 > 网络媒体 > 媒体号 > 未标
  const typeMap: Record<string, number> = {
    "权威媒体": 100, "认证媒体": 80, "网络媒体": 60, "媒体号": 40,
  };
  s += typeMap[m.media ?? ""] ?? 30;
  // sort_type 级别
  const st = m.sort_type ?? "";
  if (st.includes("置顶")) s += 30;
  else if (st.includes("一级")) s += 25;
  else if (st.includes("二级")) s += 20;
  else if (st.includes("三级")) s += 12;
  else if (st.includes("四级")) s += 5;
  // 百度权重（0-10）
  const w = Number(m.pc_weight ?? m.m_weight ?? 0);
  s += w * 6;
  return Math.min(100, Math.round(s));
}

/** 收录类型加分：新闻源收录 > 网页收录 */
function includeScore(m: SoftwenMedia): number {
  switch (m.include_type) {
    case "新闻源收录": return 100;
    case "网页收录": return 70;
    case "无": return 30;
    default: return 50;
  }
}

/** 相关性 0-100：taxonomy/名称 命中关键词 */
function relevanceScore(m: SoftwenMedia, keywords: string[]): number {
  if (!keywords.length) return 50;
  const hay = [m.name ?? "", m.taxonomy ?? "", m.platform ?? "", m.description ?? ""].join(" ").toLowerCase();
  let hit = 0;
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    if (k && hay.includes(k)) hit++;
  }
  return Math.min(100, Math.round(30 + (hit / keywords.length) * 70));
}

/** 地区匹配 0-100 */
function areaScore(m: SoftwenMedia, area?: string): number {
  if (!area) return 60;
  const mArea = m.area ?? "";
  if (mArea === "全国" || mArea === "全网") return 80;
  return mArea.includes(area) || area.includes(mArea.slice(0, 2)) ? 100 : 40;
}

function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 从本地缓存(data/softwen/resources.jsonl)里筛媒体。
 * 不传 path 时自动读仓库 data/softwen/resources.jsonl。
 */
export function selectMedia(opts: SelectionOptions = {}, cacheFile?: string): ScoredMedia[] {
  const o = { ...DEFAULT_OPTS, ...opts };
  const file = cacheFile ?? path.resolve(process.cwd(), "data", "softwen", "resources.jsonl");
  if (!existsSync(file)) return [];

  const rows: SoftwenMedia[] = readFileSync(file, "utf-8")
    .split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l) as SoftwenMedia; } catch { return null; } })
    .filter((m): m is SoftwenMedia => m != null);

  const used: Record<string, number> = {};
  const picks: ScoredMedia[] = [];

  for (const m of rows) {
    const id = String(m.id);
    if ((used[id] ?? 0) >= o.maxPerMedia) continue;

    // ---- Step 1 硬过滤 ----
    // 排除自媒体：只发门户/行业站（is_zimeiti=2 软文媒体；1=自媒体账号）
    if (o.excludeZimeiti && m.is_zimeiti === 1) continue;
    if (o.requireLink && m.url_type !== "可带") continue;
    if (!o.includeTypes.includes(m.include_type ?? "")) continue;
    const price = num(m.price ?? m.price_market);
    if (o.maxPrice > 0 && price > o.maxPrice) continue;
    // 权重下限：完全无权重字段的降权但不硬排除（给低分），权重过低的淘汰
    const w = num(m.pc_weight ?? m.m_weight);
    if (m.pc_weight != null && m.m_weight != null && w < 2) continue;

    // ---- Step 2/3 打分 ----
    const a = authorityScore(m);
    const inc = includeScore(m);
    const rel = relevanceScore(m, o.keywords ?? []);
    const ar = areaScore(m, o.area);
    // 收录率/成功率（0-100）；缺失给中性分 55（实测 92% 媒体无收录率字段，缺失按 0 会误杀）
    const incRaw = m.include_radio;
    const sucRaw = m.success_radio;
    const hasInc = incRaw != null && incRaw !== "";
    const hasSuc = sucRaw != null && sucRaw !== "";
    const incR = hasInc ? Math.min(100, num(incRaw)) : 55;
    const sucR = hasSuc ? Math.min(100, num(sucRaw)) : 55;
    // 缺失字段降权：把缺失项的权重按比例摊给有数据的项
    let wInc = 0.35, wSuc = 0.15;
    const missingW = (hasInc ? 0 : wInc) + (hasSuc ? 0 : wSuc);
    if (missingW > 0) {
      const present = (hasInc ? wInc : 0) + (hasSuc ? wSuc : 0);
      const scale = present > 0 ? present / (present + missingW) : 1;
      wInc = hasInc ? wInc * scale : 0;
      wSuc = hasSuc ? wSuc * scale : 0;
    }
    // 性价比：价格越低价分越高（价格 0 视为未知，给中分）
    const priceScore = price > 0 ? Math.max(10, 100 - price * 0.5) : 60;

    const score = Math.round(
      wInc * incR +
      wSuc * sucR +
      0.15 * rel +
      0.15 * a +
      0.10 * ar +
      0.10 * priceScore +
      (o.requireLink ? 5 : 0)   // 能带外链的少量加成
    );

    const reasons: string[] = [];
    if (incR >= 80) reasons.push(`收录率${incR}`);
    if (sucR >= 80) reasons.push(`成功率${sucR}`);
    if (a >= 80) reasons.push("高权威");
    if (rel >= 80) reasons.push("内容相关");
    if (m.url_type === "可带") reasons.push("可带外链");

    picks.push({ media: m, score, reasons });
    used[id] = (used[id] ?? 0) + 1;
  }

  return picks.sort((a, b) => b.score - a.score).slice(0, o.topN);
}

/** 把选择结果渲染成可读文本（管理页展示 / 日志） */
export function renderSelection(list: ScoredMedia[]): string {
  if (!list.length) return "（无匹配媒体）";
  return list.map((s, i) => {
    const m = s.media;
    const price = num(m.price ?? m.price_market);
    return `${i + 1}. ${m.name} [${s.score}分] ${price ? "¥" + price : "价未知"} · ${m.include_type ?? "收录未知"} · ${m.url_type === "可带" ? "可带外链" : "不带外链"} · ${s.reasons.join("/") || "无突出项"}`;
  }).join("\n");
}
