/**
 * 知识库 · 结构化信息生成
 *
 * 把企业/个人零散信息填一次，AI 结构化整理成「标准知识卡」：
 *  - 基础识别 / 定位主张 / 产品服务 / 关键事实 / 官方信源 / FAQ / 关键词
 *  - 多版本统一口径（长/中/短简介 + 站点署名） + JSON-LD（schema.org Organization）
 *  - 知识缺口分析：把知识卡事实与 AI 实时认知比对，产出「AI 不知道你的什么」→ 补缺任务
 *
 * 持久化 data/kb.jsonl（每行一份知识卡，同 key 最新生效），与 entity.ts 共用归一化主键。
 */

import { existsSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { providers } from "../config.js";
import { queryText } from "./providers.js";
import { dataPath, DEFAULT_WORKSPACE } from "./store.js";
import { runCheck } from "./check.js";
import { attachCheck, brandKey } from "./entity.js";

/* ---------- 类型 ---------- */

/** 表单原始输入（全部字符串，前端收窄） */
export interface KBInput {
  name: string;
  aliases?: string;
  site?: string;
  location?: string;
  founded?: string;
  scale?: string;
  certifications?: string;
  tagline?: string;
  uvps?: string;
  targetCustomers?: string;
  offerings?: string;
  facts?: string;
  sources?: string;
  faq?: string;
  keywords?: string;
}

export interface KBOffering { name: string; blurb: string; audience: string; }
export interface KBFact { claim: string; type: string; source: string; }
export interface KBSource { url: string; topic: string; kind: string; }
export interface KBFAQ { q: string; a: string; }

export interface KnowledgeBase {
  key: string;
  name: string;
  identity: {
    aliases: string[];
    site: string;
    location: string;
    founded: string;
    scale: string;
    certifications: string[];
  };
  positioning: { tagline: string; uvps: string[]; targetCustomers: string[] };
  offerings: KBOffering[];
  facts: KBFact[];
  sources: KBSource[];
  faq: KBFAQ[];
  keywords: string[];
  versions: { long: string; medium: string; short: string; byline: string };
  ldJson: string;
  updatedAt: string;
  /** 最近一次知识缺口分析 */
  gap?: KbGap;
}

/** 知识缺口分析结果：AI 认知到了知识卡的几分之几 */
export interface KbGap {
  at: string;
  total: number;        // 事实总数
  covered: number;      // AI 认知到的
  weak: number;         // 部分提及
  missing: string[];    // AI 完全没提到的
  weakList: string[];
  score: number;        // 认知完整度 0-100
  scoreNote: string;
  /** AI 现在把你看成了谁（首条有效回答摘要，让人一眼看到认知偏差） */
  aiSummary: string;
}

/* ---------- 输入解析 ---------- */

const lines = (s?: string) => (s || "").split("\n").map((x) => x.trim()).filter(Boolean);
const csv = (s?: string) => (s || "").split(/[,，、]/).map((x) => x.trim()).filter(Boolean);

/** 产品行：`名称：说明` 或 `名称:说明` 或 `名称-说明`（audience 留空） */
function parseOfferings(s?: string): KBOffering[] {
  return lines(s).map((line) => {
    const m = line.match(/^([^：:—-]{1,24})[：:\-—](.+)$/);
    return m ? { name: m[1].trim(), blurb: m[2].trim(), audience: "" } : { name: line, blurb: "", audience: "" };
  });
}

/** FAQ 行：`问题：答案` */
function parseFaq(s?: string): KBFAQ[] {
  return lines(s).map((line) => {
    const m = line.match(/^(.{3,60})[：:](.+)$/);
    return m ? { q: m[1].trim(), a: m[2].trim() } : { q: line, a: "" };
  });
}

/** 事实行：`声明[｜来源[｜类型]]` */
function parseFacts(s?: string): KBFact[] {
  return lines(s).map((line) => {
    const parts = line.split(/[｜|]/).map((x) => x.trim()).filter(Boolean);
    return { claim: parts[0] || "", source: parts[1] || "", type: parts[2] || "其他" };
  });
}

/** 信源行：`URL[｜主题[｜类型]]` */
function parseSources(s?: string): KBSource[] {
  return lines(s).map((line) => {
    const parts = line.split(/[｜|]/).map((x) => x.trim()).filter(Boolean);
    return { url: parts[0] || "", topic: parts[1] || "", kind: parts[2] || "other" };
  });
}

/* ---------- 确定性兜底生成（LLM 不可用时保证模块可用） ---------- */

function fallbackVersions(i: KBInput): KnowledgeBase["versions"] {
  const name = i.name;
  const tagline = i.tagline ? i.tagline.replace(/[。.]+$/, "") : "";
  const kw = csv(i.keywords).join("、");
  const site = i.site || "";
  const body = [
    tagline,
    csv(i.certifications).length ? "资质：" + csv(i.certifications).join("、") : "",
    lines(i.uvps).slice(0, 3).join("；"),
    site,
    kw,
  ].filter(Boolean);
  return {
    long: [name, ...body].join("｜"),
    medium: [name, tagline, kw, site].filter(Boolean).join(" · "),
    short: [name, tagline, site].filter(Boolean).join("｜"),
    byline: `${name}${tagline ? " — " + tagline : ""} · ${site || ""}`,
  };
}

function fallbackLdJson(i: KBInput, kb: KnowledgeBase): string {
  const org: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: kb.name,
    url: kb.identity.site || undefined,
    description: kb.positioning.tagline || undefined,
    keywords: kb.keywords.join(",") || undefined,
    knowsAbout: kb.offerings.length ? kb.offerings.map((o) => o.name) : undefined,
  };
  if (kb.identity.aliases.length) org.alternateName = kb.identity.aliases;
  if (kb.identity.location) org.address = { "@type": "PostalAddress", addressLocality: kb.identity.location };
  return JSON.stringify(org);
}

function fromInput(i: KBInput): KnowledgeBase {
  const key = brandKey(i.name);
  const base: KnowledgeBase = {
    key,
    name: i.name.trim(),
    identity: {
      aliases: csv(i.aliases),
      site: (i.site || "").trim(),
      location: (i.location || "").trim(),
      founded: (i.founded || "").trim(),
      scale: (i.scale || "").trim(),
      certifications: csv(i.certifications),
    },
    positioning: {
      tagline: (i.tagline || "").trim(),
      uvps: lines(i.uvps),
      targetCustomers: lines(i.targetCustomers),
    },
    offerings: parseOfferings(i.offerings),
    facts: parseFacts(i.facts),
    sources: parseSources(i.sources),
    faq: parseFaq(i.faq),
    keywords: csv(i.keywords),
    versions: { long: "", medium: "", short: "", byline: "" },
    ldJson: "",
    updatedAt: new Date().toISOString(),
  };
  base.versions = fallbackVersions(i);
  base.ldJson = fallbackLdJson(i, base);
  return base;
}

/* ---------- AI 结构化整理 ---------- */

const STRUCT_PROMPT = `你是一个 GEO（生成引擎优化）内容工程师。用户会给你一家企业/个人的零散原始信息，请整理成「结构化知识卡」，让 AI 搜索引擎能准确、一致地认识它。

输入（JSON）：
{{INPUT}}

只输出一个 JSON 对象（不要任何其他文字、不要 markdown 代码块），结构必须如下：
{
  "identity": { "aliases": ["别名"], "site": "官网", "location": "所在地", "founded": "成立时间", "scale": "规模", "certifications": ["认证资质"] },
  "positioning": { "tagline": "一句话定位", "uvps": ["差异化价值点"], "targetCustomers": ["目标客户"] },
  "offerings": [ { "name": "产品/服务名", "blurb": "一句话说明", "audience": "适用对象" } ],
  "facts": [ { "claim": "一句话可验证事实", "type": "资质|数据|案例|奖项|其他", "source": "来源" } ],
  "sources": [ { "url": "官方页面URL", "topic": "该页主题", "kind": "about|product|article|contact|other" } ],
  "faq": [ { "q": "常见问题", "a": "标准答案" } ],
  "keywords": ["核心关键词"],
  "versions": { "long": "长简介（约120字）", "medium": "中简介（约70字）", "short": "一句话简介", "byline": "站点署名一行" },
  "ldJson": "{@type:Organization 的 schema.org JSON-LD 字符串}"
}

规则：
1. 全部简体中文，语气客观、像百科词条。
2. 关键事实(claim)写成 AI 容易复述的短句，如「成立于2010年」「已获得ISO9001认证」「在成都有30家门店」。
3. 没有的信息留空字符串或空数组，严禁编造。
4. ldJson 输出为字符串（本身是 JSON 序列化后的 Organization 结构）。`;

function extractJson(raw: string): unknown {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("输出中没有 JSON");
  return JSON.parse(s.slice(a, b + 1));
}

/** 生成结构化知识卡：优先 LLM 整理，失败回退确定性组装 */
export async function generateKB(input: KBInput): Promise<KnowledgeBase> {
  const base = fromInput(input);
  const api = providers.find((p) => p.id === "deepseek");
  if (!api) return base;
  try {
    const r = await queryText(api, STRUCT_PROMPT.replace("{{INPUT}}", JSON.stringify(input)));
    if (r.error) return base;
    const j = extractJson(r.raw) as Partial<KnowledgeBase>;
    const pick = <T>(v: T | undefined, d: T): T => (v === undefined || v === null || v === "" ? d : v);
    // 数组：LLM 给了非空数组用 LLM 的，否则用解析版
    const pickArr = (v: unknown, d: unknown[]) => (Array.isArray(v) && v.length ? (v as unknown[]) : d);
    // 逐字段合并：LLM 给的生效，空/缺的用解析版兜底
    const merged: KnowledgeBase = {
      ...base,
      identity: {
        aliases: pickArr(j.identity?.aliases, base.identity.aliases) as string[],
        site: pick(j.identity?.site, base.identity.site),
        location: pick(j.identity?.location, base.identity.location),
        founded: pick(j.identity?.founded, base.identity.founded),
        scale: pick(j.identity?.scale, base.identity.scale),
        certifications: pickArr(j.identity?.certifications, base.identity.certifications) as string[],
      },
      positioning: {
        tagline: pick(j.positioning?.tagline, base.positioning.tagline),
        uvps: pickArr(j.positioning?.uvps, base.positioning.uvps) as string[],
        targetCustomers: pickArr(j.positioning?.targetCustomers, base.positioning.targetCustomers) as string[],
      },
      offerings: pickArr(j.offerings, base.offerings) as KBOffering[],
      facts: pickArr(j.facts, base.facts) as KBFact[],
      sources: pickArr(j.sources, base.sources) as KBSource[],
      faq: pickArr(j.faq, base.faq) as KBFAQ[],
      keywords: pickArr(j.keywords, base.keywords) as string[],
      versions: {
        long: pick(j.versions?.long, base.versions.long),
        medium: pick(j.versions?.medium, base.versions.medium),
        short: pick(j.versions?.short, base.versions.short),
        byline: pick(j.versions?.byline, base.versions.byline),
      },
      ldJson: pick(String(j.ldJson ?? ""), base.ldJson),
    };
    return merged;
  } catch {
    return base;
  }
}

/* ---------- 持久化 data/kb.jsonl ---------- */

const file = dataPath(DEFAULT_WORKSPACE, "kb.jsonl");

export function saveKB(kb: KnowledgeBase): void {
  appendFileSync(file, JSON.stringify(kb) + "\n", "utf-8");
}

export function getKB(key: string): KnowledgeBase | null {
  if (!existsSync(file)) return null;
  const linesArr = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  for (let i = linesArr.length - 1; i >= 0; i--) {
    try {
      const k = JSON.parse(linesArr[i]) as KnowledgeBase;
      if (k.key === key) return k;
    } catch { /* 跳过损坏行 */ }
  }
  return null;
}

export function listKBs(): KnowledgeBase[] {
  if (!existsSync(file)) return [];
  const seen = new Set<string>();
  const out: KnowledgeBase[] = [];
  const linesArr = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  for (let i = linesArr.length - 1; i >= 0; i--) {
    try {
      const k = JSON.parse(linesArr[i]) as KnowledgeBase;
      if (!seen.has(k.key)) { seen.add(k.key); out.push(k); }
    } catch { /* 跳过损坏行 */ }
  }
  return out;
}

/* ---------- 知识缺口分析 ---------- */

function norm(s: string): string {
  return s.toLowerCase().replace(/[\s·•●]+/g, "");
}

/** 中文常见功能词（2 字），bigram 命中时忽略，避免「技术/企业」这类泛词造成假阳性 */
const STOP2 = new Set([
  "专注", "研究", "行业", "企业", "提供", "服务", "相关", "领域", "主要", "产品",
  "进行", "支持", "我们", "以及", "方面", "公司", "团队", "业务", "内容", "这些",
  "那些", "可以", "需要", "能够", "具有", "通过", "对于", "关于", "认为", "称为",
  "属于", "包括", "涉及", "面向", "围绕", "基于", "其中", "目前", "当前", "我们",
]);
const isStop2 = (w: string) => STOP2.has(w) || (/[的得地了与和及也又在很着等]/).test(w);

/** 单个子句是否被 AI 认知到：有拉丁/数字标志词就看它是否出现；纯中文按 bigram 命中率 */
function knownIn(answers: string[], clause: string): boolean {
  const joined = answers.map(norm).join("\n"); // 归一化（小写、去空白），与 clause 口径一致
  const tokens = clause.match(/[a-z0-9]{2,}/gi) || [];
  if (tokens.length) return tokens.some((t) => joined.includes(t.toLowerCase()));
  let total = 0;
  let hit = 0;
  for (let i = 0; i + 1 < clause.length; i++) {
    const w = clause.slice(i, i + 2);
    if (isStop2(w)) continue;
    total++;
    if (joined.includes(w)) hit++;
  }
  return total > 0 && hit / total >= 0.35;
}

/**
 * 事实匹配：LLM 会把事实扩写成带实体名前缀的完整句，先剥掉实体名，
 * 再按标点切成子句逐个判断（命中率 0-1）。
 */
function matchFact(claim: string, answers: string[], entityName: string): number {
  const name = norm(entityName);
  let clean = norm(claim);
  if (name && clean.startsWith(name)) clean = clean.slice(name.length);
  const clauses = clean.split(/[，。；、,.;;：:！!?？]/).filter((c) => c.length >= 4);
  if (!clauses.length) return knownIn(answers, clean) ? 1 : 0;
  const hits = clauses.filter((c) => knownIn(answers, c)).length;
  return hits / clauses.length;
}

/** 跑一次检测，把知识卡「关键事实」与 AI 实时认知比对 */
export async function runGapAnalysis(kb: KnowledgeBase): Promise<KbGap> {
  const report = await runCheck(kb.name);
  attachCheck(report); // 检测本身也进实体档案，认知曲线照常累积
  const answers = report.results.filter((r) => !r.error).map((r) => r.answer);

  const covered: string[] = [];
  const weakList: string[] = [];
  const missing: string[] = [];
  for (const f of kb.facts) {
    if (!f.claim) continue;
    const ratio = matchFact(f.claim, answers, kb.name);
    if (ratio >= 0.5) covered.push(f.claim);
    else if (ratio >= 0.25) weakList.push(f.claim);
    else missing.push(f.claim);
  }
  const total = kb.facts.length || 0;
  const score = total ? Math.round(((covered.length + weakList.length * 0.5) / total) * 100) : 0;
  const scoreNote =
    score >= 80 ? "AI 基本吃透了你的关键事实，可以深耕更多场景问题"
    : score >= 50 ? "AI 认识你但不深，下面这些事实它没说出来——补到官网/内容里"
    : "AI 对你的认知还比较空，先把下面的事实建到官方信源页";

  // AI 现在把你看成了谁（首条有效回答摘要，去 markdown 符号）
  const first = report.results.find((r) => !r.error && r.answer);
  const aiSummary = first
    ? first.answer.replace(/[#*`>_-]/g, "").replace(/\s+/g, " ").trim().slice(0, 100)
    : "";

  return { at: new Date().toISOString(), total, covered: covered.length, weak: weakList.length, missing, weakList, score, scoreNote, aiSummary };
}
