/**
 * 发稿效果矩阵 — 「行业 × 渠道 × AI 引用效果」的数据护城河层
 *
 * 把三份已有数据串成一个统计矩阵（不引入新数据源，全部是已有资产）：
 *   台账 data/publish.json        谁、什么时候、发到了哪个媒体
 *   文章监测 data/articles.json   那篇稿子后来有没有被 AI 引用（文章级/站点级）
 *   媒体目录 data/softwen/resources.jsonl  渠道元数据（收录类型 / 是否自媒体）
 *
 * 每个 (行业, 渠道) 组合用 Beta-Binomial 贝叶斯更新估计「AI 引用命中率」：
 *   先验 Beta(1,1)（均匀）；每篇稿子文章级被引 +1 hit，否则 +1 miss；
 *   后验 Beta(1+hits, 1+misses) → 均值 = (1+hits)/(2+hits+misses)，
 *   可信区间取后验 5%/95% 分位（正则化不完全 Beta 数值求逆，小样本也稳）。
 *
 * 推荐排序用「后验 5% 低值」（保守下界）——避免一两次运气让小样本渠道排第一。
 *
 * 命中口径（对应「收录 vs 引用」双层设计）：
 *   - hits    文章级被引（AI 精确引用了发布链接的 URL 路径）→ 计入命中率
 *   - siteHits 站点级被引（AI 提到了媒体域名）→ 单独记录，不进命中率
 *   收录检查（是否被引擎索引）是结构性前置，MVP 用「已纳入监测且有探测结果」作为
 *   「可检索」前提；真正收录层判定留给后续（需 Baidu/AI 索引接口，本期不做）。
 *
 * 用法：
 *   npm run effect                # 命令行打印矩阵 + 各行业推荐
 *   GET /api/effect/matrix        # 公网读全量矩阵
 *   GET /api/effect/recommend?industry=餐饮
 *   buildEffectMatrix 落盘 data/effect-matrix.json + 摘要 data/effect-log.jsonl
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadLedger, type PublishRecord } from "./pack.js";
import { loadArticles, type Article } from "./articles.js";

/* ================= Beta-Binomial 贝叶斯 ================= */

/** log-gamma（Lanczos，g=7） */
function lgamma(z: number): number {
  const C = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  let x = z - 1;
  let acc = C[0];
  for (let i = 1; i < 9; i++) acc += C[i] / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(acc);
}

/** 正则化不完全 Beta 的连分式（Numerical Recipes betacf） */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-9;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** 正则化不完全 Beta I_x(a,b) */
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return (bt * betacf(a, b, x)) / a;
}

/** Beta 分位数（二分求逆，精度 ~1e-16 * 后验规模） */
export function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  if (a <= 0 || b <= 0) return Number.NaN;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (betai(a, b, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface Posterior {
  alpha: number;
  beta: number;
  mean: number;
  lower: number; // 5% 分位（保守下界，排序主键）
  upper: number; // 95% 分位
}

/** 后验 Beta(1+hits, 1+misses) 的均值 + 5%/95% 可信区间 */
export function posteriorFor(hits: number, misses: number): Posterior {
  const alpha = 1 + hits;
  const beta = 1 + misses;
  const mean = alpha / (alpha + beta);
  return { alpha, beta, mean, lower: betaQuantile(0.05, alpha, beta), upper: betaQuantile(0.95, alpha, beta) };
}

/* ================= 效果矩阵类型 ================= */

export interface ResourceLite {
  id: string;
  name: string;
  includeType?: string;
  isZimeiti?: number;
  taxonomy?: string;
}

export interface ChannelEffect {
  channelKey: string;
  channelName: string;
  resourceId?: string;
  domain?: string;
  supplier?: string;
  industry: string;
  trials: number;
  hits: number;       // 文章级被引（URL 精确命中）
  siteHits: number;   // 站点级被引（域名被提到）
  misses: number;
  firstAt: string;
  lastAt: string;
  lastVerdict?: string;
  posterior: Posterior;
  verdict: string;
  media?: { includeType?: string; isZimeiti?: number; taxonomy?: string };
}

export interface EffectMatrix {
  generatedAt: string;
  industries: string[];
  rows: ChannelEffect[];
  stats: {
    industries: number;
    channels: number;
    trials: number;
    hits: number;
    hitRate: number;
    siteHits: number;
    activeChannels: number;
  };
}

/* ================= 推导辅助 ================= */

/** 需求单 → 行业：借势话题「」内 > 首个关键词 > 兜底「通用」 */
function industryFor(rec: PublishRecord): string {
  const plan = rec.plan;
  const m = plan?.source?.scene?.match(/「([^」]+)」/);
  if (m?.[1]) return m[1];
  const kw = plan?.packs?.[0]?.keywords?.[0];
  if (kw) return kw;
  return "通用";
}

function extractDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    const m = url.toLowerCase().match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/);
    return m?.[1];
  }
}

/** 供应商标识：显式 supplier 优先，否则按 channel 前缀推断（软文街→softwen） */
function supplierOf(pub: { supplier?: string; channel?: string }): string {
  if (pub.supplier) return pub.supplier;
  const prefix = pub.channel?.split("#")[0] ?? "";
  if (prefix === "软文街") return "softwen";
  return "unknown";
}

/** 发稿记录 → 渠道标识：key 带供应商命名空间（softwen#r1126），多供应商同媒体不串行 */
function channelOf(pub: { channel?: string; url: string; supplier?: string }): { key: string; name: string; resourceId?: string; domain?: string; supplier: string } {
  const domain = extractDomain(pub.url);
  const supplier = supplierOf(pub);
  // channel 形如「供应商#资源ID·媒体名」——解析不写死软文街，媒介盒子等接入用同格式即可
  const m = pub.channel?.match(/^(?:.*?)#([0-9]+)(?:·(.*))?$/);
  if (m) {
    const id = m[1];
    return { key: `${supplier}#r${id}`, name: m[2]?.trim() || domain || id, resourceId: id, domain, supplier };
  }
  if (domain) return { key: `${supplier}#${domain}`, name: pub.channel || domain, domain, supplier };
  return { key: `${supplier}#${pub.channel || "unknown"}`, name: pub.channel || "unknown", supplier };
}

/** 渠道结论：样本不足 / 未命中 / 强渠道 / 可用 / 待观察 */
export function channelVerdict(r: { trials: number; hits: number; posterior: Posterior }): string {
  if (r.trials < 2) return "样本不足";
  if (r.hits === 0) return "未命中";
  if (r.posterior.lower >= 0.4) return "强渠道";
  if (r.posterior.mean >= 0.35) return "可用";
  return "待观察";
}

/* ================= 矩阵构建（纯函数，可测） ================= */

export function computeEffectMatrix(input: {
  records: PublishRecord[];
  articles: Article[];
}): EffectMatrix {
  const byUrl = new Map<string, Article>();
  for (const a of input.articles) if (a.url && a.lastCheck) byUrl.set(a.url, a);

  const rows = new Map<string, ChannelEffect>();
  for (const rec of input.records) {
    const industry = industryFor(rec);
    for (const pub of rec.publications) {
      if (!pub.url) continue; // 未发布成功 / 回调未回填
      const art = byUrl.get(pub.url);
      if (!art?.lastCheck) continue; // 未纳入文章监测（无探测结果）
      const lc = art.lastCheck;
      const ch = channelOf(pub);
      const key = `${industry}\u0000${ch.key}`;
      const hit = lc.articleCitedBy.length > 0;
      const siteHit = lc.siteCitedBy.length > 0;
      const at = lc.checkedAt || art.createdAt;

      const prev = rows.get(key);
      const next: ChannelEffect = prev
        ? {
            ...prev,
            trials: prev.trials + 1,
            hits: prev.hits + (hit ? 1 : 0),
            siteHits: prev.siteHits + (siteHit ? 1 : 0),
            misses: prev.misses + (hit ? 0 : 1),
            lastAt: at > prev.lastAt ? at : prev.lastAt,
            firstAt: prev.firstAt < at ? prev.firstAt : at,
            lastVerdict: lc.verdict,
          }
        : {
            channelKey: ch.key,
            channelName: ch.name,
            resourceId: ch.resourceId,
            domain: ch.domain,
            supplier: ch.supplier,
            industry,
            trials: 1,
            hits: hit ? 1 : 0,
            siteHits: siteHit ? 1 : 0,
            misses: hit ? 0 : 1,
            firstAt: at,
            lastAt: at,
            lastVerdict: lc.verdict,
            posterior: posteriorFor(hit ? 1 : 0, hit ? 0 : 1),
            verdict: "",
          };
      next.posterior = posteriorFor(next.hits, next.misses);
      next.verdict = channelVerdict(next);
      rows.set(key, next);
    }
  }

  const list = [...rows.values()].sort(
    (a, b) => a.industry.localeCompare(b.industry, "zh") || b.trials - a.trials || b.hits - a.hits
  );
  const trials = list.reduce((s, r) => s + r.trials, 0);
  const hits = list.reduce((s, r) => s + r.hits, 0);

  return {
    generatedAt: new Date().toISOString(),
    industries: [...new Set(list.map((r) => r.industry))].sort((a, b) => a.localeCompare(b, "zh")),
    rows: list,
    stats: {
      industries: new Set(list.map((r) => r.industry)).size,
      channels: list.length,
      trials,
      hits,
      hitRate: trials ? Math.round((hits / trials) * 1000) / 10 : 0,
      siteHits: list.reduce((s, r) => s + r.siteHits, 0),
      activeChannels: list.filter((r) => r.hits > 0).length,
    },
  };
}

/* ================= 真实数据入口 + 媒体元数据 ================= */

/** 轻量媒体索引：只留 {id, name, include_type, is_zimeiti, taxonomy}，避免把 9 万+ 大对象全驻内存 */
function loadResourceIndex(file = path.resolve(process.cwd(), "data", "softwen", "resources.jsonl")): Map<string, ResourceLite> | null {
  if (!existsSync(file)) return null;
  const map = new Map<string, ResourceLite>();
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line) continue;
    try {
      const m = JSON.parse(line) as any;
      if (m?.id != null) map.set(String(m.id), { id: String(m.id), name: String(m.name ?? ""), includeType: m.include_type, isZimeiti: m.is_zimeiti, taxonomy: m.taxonomy });
    } catch { /* 坏行跳过 */ }
  }
  return map;
}

let cachedResourceIndex: Map<string, ResourceLite> | null | undefined;

function getResourceIndex(): Map<string, ResourceLite> | null {
  if (cachedResourceIndex !== undefined) return cachedResourceIndex;
  cachedResourceIndex = loadResourceIndex();
  return cachedResourceIndex;
}

/** 从真实仓库数据构建矩阵（台账 + 文章监测 + 行业表 + 媒体目录） */
export function buildEffectMatrix(): EffectMatrix {
  const records = loadLedger();
  const articles = loadArticles();
  const matrix = computeEffectMatrix({ records, articles });

  // 只有真有数据行时才加载 9 万+ 媒体目录（懒加载 + 进程内缓存）
  if (matrix.rows.length) {
    const idx = getResourceIndex();
    if (idx) {
      for (const r of matrix.rows) {
        if (!r.resourceId) continue;
        const m = idx.get(r.resourceId);
        if (m) r.media = { includeType: m.includeType, isZimeiti: m.isZimeiti, taxonomy: m.taxonomy };
      }
    }
  }
  return matrix;
}

/** 按行业推荐渠道：后验 5% 低值排序（保守），要求最少试次，默认排除自媒体 */
export function recommendForIndustry(industry: string, opts: { topN?: number; minTrials?: number; excludeZimeiti?: boolean } = {}): ChannelEffect[] {
  const { topN = 10, minTrials = 2, excludeZimeiti = true } = opts;
  const matrix = buildEffectMatrix();
  let rows = matrix.rows.filter((r) => r.industry === industry && r.trials >= minTrials);
  if (excludeZimeiti) rows = rows.filter((r) => r.media?.isZimeiti !== 1);
  return rows
    .sort((a, b) => b.posterior.lower - a.posterior.lower || b.posterior.mean - a.posterior.mean || b.trials - a.trials)
    .slice(0, topN);
}

/* ================= 落盘：快照 + 历史 ================= */

/** 最新全量矩阵 → data/effect-matrix.json；统计摘要 append → data/effect-log.jsonl */
export function appendEffectSnapshot(matrix: EffectMatrix): void {
  const dir = path.resolve(process.cwd(), "data");
  writeFileSync(path.join(dir, "effect-matrix.json"), JSON.stringify(matrix, null, 2) + "\n", "utf-8");
  appendFileSync(path.join(dir, "effect-log.jsonl"), JSON.stringify({ at: matrix.generatedAt, ...matrix.stats }) + "\n", "utf-8");
}

/* ================= CLI：npm run effect ================= */

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const matrix = buildEffectMatrix();
  const s = matrix.stats;
  console.log(`发稿效果矩阵（生成于 ${matrix.generatedAt.slice(0, 16)}）`);
  console.log(`  行业 ${s.industries} · 渠道 ${s.channels} · 发稿试次 ${s.trials} · 文章级被引 ${s.hits}（${s.hitRate}%）· 站点级被引 ${s.siteHits} · 有效渠道 ${s.activeChannels}`);
  console.log("");

  if (!matrix.rows.length) {
    console.log("（暂无数据）");
    console.log("产生数据需要两步都满足：");
    console.log("  1. 台账有「已发布且回调回填了链接」的发稿记录（publish.json.publications[].url）");
    console.log("  2. 该链接已纳入文章监测并有探测结果（articles.json lastCheck）——回调/软文街 track 会自动纳入");
    console.log("  → 账号实名认证通过后发稿，闭环即开始自动积累。");
  } else {
    for (const ind of matrix.industries) {
      const recs = recommendForIndustry(ind, { minTrials: 1, excludeZimeiti: false });
      console.log(`【${ind}】`);
      for (const r of recs) {
        const lo = (r.posterior.lower * 100).toFixed(0);
        const up = (r.posterior.upper * 100).toFixed(0);
        const mean = (r.posterior.mean * 100).toFixed(0);
        console.log(`  ${r.channelName.padEnd(16)} n=${String(r.trials).padStart(2)} 命中=${r.hits}  区间 ${lo}%-${up}%（均值 ${mean}%）  ${r.verdict}${r.media?.isZimeiti === 1 ? " [自媒体]" : ""}`);
      }
    }
  }
}
