/**
 * 统一实体层 — 所有模块的数据归到同一份「实体档案」。
 *
 * 检测 / 域名追踪 / 竞品智能 的结果全部按归一化实体 key 落盘到 data/entities.json，
 * 每个品牌/域名一份档案（检测历史 + 引用 + 场景份额）——「企业 AI 认知地图」的数据底座。
 *
 * 归一化规则：小写、去协议、去 www、去空白。同一次检测/复测每次归到同一份档案。
 * 品牌「海底捞」与域名 haidilao.com 目前是两份档案（需后续映射规则自动合并）。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CheckReport } from "./check.js";
import type { SceneCompareReport } from "./compare.js";

export type EntityKind = "brand" | "site";

export interface CheckSnapshot {
  at: string;
  score: number;
  verdict: string;
  mention: boolean;
  cited: boolean;
  sources: string[];
}

export interface CitationRef {
  at: string;
  /** 引用了它的 AI 源 label */
  source: string;
  kind: "site" | "article" | "title";
  url?: string;
  title?: string;
}

export interface SceneShare {
  at: string;
  scene: string;
  share: number;
  rank: number;
  total: number;
}

export interface EntityProfile {
  key: string;
  name: string;
  kind: EntityKind;
  industry?: string;
  keywords: string[];
  site?: string;
  createdAt: string;
  /** 检测历史时间序列（新的在后） */
  checks: CheckSnapshot[];
  citations: CitationRef[];
  sceneShares: SceneShare[];
}

const file = path.resolve(process.cwd(), "data/entities.json");

export function loadEntities(): EntityProfile[] {
  try {
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, "utf-8")) as EntityProfile[];
  } catch {
    return [];
  }
}

export function saveEntities(list: EntityProfile[]): void {
  writeFileSync(file, JSON.stringify(list, null, 2) + "\n", "utf-8");
}

/** 归一化实体主键：小写、去协议、去 www、去空白 */
export function brandKey(input: string): string {
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\s+/g, "");
}

/** 取或建档案；meta 只在新建时生效 */
export function getOrCreate(
  key: string,
  meta: { name: string; kind: EntityKind; industry?: string; keywords?: string[]; site?: string }
): { profile: EntityProfile; created: boolean } {
  const list = loadEntities();
  const found = list.find((e) => e.key === key);
  if (found) return { profile: found, created: false };
  const profile: EntityProfile = {
    key,
    name: meta.name || key,
    kind: meta.kind,
    industry: meta.industry,
    keywords: meta.keywords ?? [],
    site: meta.site,
    createdAt: new Date().toISOString(),
    checks: [],
    citations: [],
    sceneShares: [],
  };
  list.push(profile);
  saveEntities(list);
  return { profile, created: true };
}

function save(profile: EntityProfile): void {
  const list = loadEntities();
  const i = list.findIndex((e) => e.key === profile.key);
  if (i >= 0) list[i] = profile;
  else list.push(profile);
  saveEntities(list);
}

/** 检测报告 → 实体档案（问句不入档案） */
export function attachCheck(report: CheckReport): void {
  if (report.type === "question") return;
  const { profile } = getOrCreate(brandKey(report.entity), { name: report.entityLabel, kind: report.type });
  profile.checks.push({
    at: report.createdAt,
    score: report.score,
    verdict: report.verdict,
    mention: report.results.some((r) => r.mention),
    cited: report.results.some((r) => r.source),
    sources: report.results.filter((r) => r.source).map((r) => r.providerLabel),
  });
  profile.checks = profile.checks.slice(-200);
  save(profile);
}

/** 竞品智能场景结果 → 各实体档案（self + 竞品都记，场景份额序列） */
export function attachSceneShares(report: SceneCompareReport): void {
  for (const e of report.entities) {
    const { profile } = getOrCreate(brandKey(e.name), { name: e.name, kind: "brand" });
    profile.sceneShares.push({
      at: report.checkedAt,
      scene: report.scene,
      share: e.share,
      rank: report.entities.indexOf(e) + 1,
      total: report.entities.length,
    });
    profile.sceneShares = profile.sceneShares.slice(-50);
    save(profile);
  }
}

/** 域名引用追踪 → 站点档案（把「哪个 AI 引用了你」记为引用） */
export function attachCiteCitation(domain: string, checkedAt: string, sources: string[]): void {
  const { profile } = getOrCreate(brandKey(domain), { name: domain, kind: "site" });
  for (const src of sources) {
    profile.citations.push({ at: checkedAt, source: src, kind: "site" });
  }
  profile.citations = profile.citations.slice(-100);
  save(profile);
}

/** 数据底座统计：给「企业 AI 认知地图」与行业聚合用 */
export function entityStats() {
  const list = loadEntities();
  const withChecks = list.filter((e) => e.checks.length > 0);
  const topScored = withChecks
    .map((e) => ({
      key: e.key,
      name: e.name,
      kind: e.kind,
      lastScore: e.checks[e.checks.length - 1].score,
      checks: e.checks.length,
      lastAt: e.checks[e.checks.length - 1].at,
    }))
    .sort((a, b) => b.lastScore - a.lastScore)
    .slice(0, 20);
  return {
    total: list.length,
    brands: list.filter((e) => e.kind === "brand").length,
    sites: list.filter((e) => e.kind === "site").length,
    withChecks: withChecks.length,
    totalChecks: list.reduce((s, e) => s + e.checks.length, 0),
    sceneShares: list.reduce((s, e) => s + e.sceneShares.length, 0),
    citations: list.reduce((s, e) => s + e.citations.length, 0),
    topScored,
  };
}
