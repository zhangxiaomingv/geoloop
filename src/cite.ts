/**
 * 域名追踪 — 引用追踪（Citation Tracker）总模块的子模块。
 * 对同一域名周期性复测 AI 可见度（认知 + 描述 + 来源引用），
 * 每次结果追加为历史时间线，前端据此画引用趋势。
 *
 * 与文章监测的关系：文章监测看「某篇文章有没有被采用」，
 * 域名追踪看「整个站点在 AI 里的引用趋势」——同一总模块下的两个视角。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runCheck } from "./check.js";
import { attachCheck } from "./entity.js";
import { dataPath, DEFAULT_WORKSPACE } from "./store.js";

export interface SiteCheck {
  checkedAt: string;
  /** 0-100，各源均分 */
  score: number;
  verdict: string;
  /** 是否有源在回答中把该域名作为来源引用 */
  cited: boolean;
  /** 是否有源提及了该域名 */
  mention: boolean;
  /** 引用了该域名的源名称 */
  sources: string[];
}

export interface CiteSite {
  id: string;
  domain: string;
  createdAt: string;
  /** 最近 N 次检测历史（新的在后） */
  checks: SiteCheck[];
}

const file = dataPath(DEFAULT_WORKSPACE, "cites.json");

export function loadCites(): CiteSite[] {
  try {
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, "utf-8")) as CiteSite[];
  } catch {
    return [];
  }
}

export function saveCites(sites: CiteSite[]): void {
  writeFileSync(file, JSON.stringify(sites, null, 2) + "\n", "utf-8");
}

/** 对单个域名跑一次检测，抽出引用追踪需要的字段 */
export async function checkCiteSite(site: CiteSite): Promise<SiteCheck> {
  const report = await runCheck(site.domain);
  attachCheck(report); // 统一实体层：域名复测自动进实体档案
  return {
    checkedAt: new Date().toISOString(),
    score: report.score,
    verdict: report.verdict,
    cited: report.results.some((r) => r.source),
    mention: report.results.some((r) => r.mention),
    sources: report.results.filter((r) => r.source).map((r) => r.providerLabel),
  };
}

/** 全部域名串行复测（避免同时打爆 API 源），保留最近 30 次历史 */
export async function checkCites(sites: CiteSite[]): Promise<CiteSite[]> {
  for (const site of sites) {
    const check = await checkCiteSite(site);
    site.checks = [...site.checks, check].slice(-30);
  }
  return sites;
}
