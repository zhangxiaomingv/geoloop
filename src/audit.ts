/**
 * 站点 AI 友好度审计 — GEOloop 闭环第一层（结构层）
 *
 * 输入 URL → 确定性检查（robots / sitemap / llms.txt / 纯 HTML 内容 / 结构化数据）
 * → AI 友好度评分（0-100）+ 行动清单。
 *
 * 与 check.ts 的「AI 认知检测」拼成完整闭环：
 *   ①结构层（本文件，秒级、不调 LLM）：AI 能不能读懂你的网站
 *   ②认知层（check.ts）：AI 到底认不认识你
 *   ③行动清单：缺什么、按什么顺序补
 *
 * 本机测试实例独立运行（端口 8799），不影响线上容器。
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { runCheck, type CheckReport } from "./check.js";

/* ---------- 工具 ---------- */

const AUDITS_FILE = path.resolve(process.cwd(), "data/audits.jsonl");
const BOTS_FILE = path.resolve(process.cwd(), "data/bots.json");

/** 抓取 URL：超时 + 跟随跳转 + 普通浏览器 UA（fetch 天然不执行 JS，正好等价 AI 爬虫视角） */
async function fetchText(url: string, timeoutMs = 8000): Promise<{ ok: boolean; status: number; text: string; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 域名归一化：www/协议剥离 → { domain, baseUrl } */
export function normalizeDomain(input: string): { domain: string; baseUrl: string } {
  let s = input.trim().toLowerCase();
  if (!/^https?:\/\//.test(s)) s = "https://" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("URL 不合法");
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    throw new Error("请输入合法域名，如 example.com");
  }
  return { domain: host, baseUrl: `https://${host}` };
}

/* ---------- bots.json（AI 爬虫名单） ---------- */

export interface BotInfo {
  id: string;
  vendor: string;
  engine: string;
  match: string[];
}

function loadBots(): BotInfo[] {
  try {
    const raw = JSON.parse(readFileSync(BOTS_FILE, "utf-8")) as Array<{
      id: string;
      vendor?: string;
      engine?: string;
      match?: string[];
    }>;
    return raw
      .filter((b) => Array.isArray(b.match) && b.match.length > 0)
      .map((b) => ({ id: b.id, vendor: b.vendor ?? "", engine: b.engine ?? "", match: b.match as string[] }));
  } catch {
    return [];
  }
}

/* ---------- robots.txt 解析 ---------- */

export interface RobotsRule {
  userAgents: string[];
  disallow: string[];
  allow: string[];
}

export function parseRobots(text: string): { rules: RobotsRule[]; sitemaps: string[] } {
  const rules: RobotsRule[] = [];
  const sitemaps: string[] = [];
  let current: RobotsRule | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      current = { userAgents: value ? [value.toLowerCase()] : ["*"], disallow: [], allow: [] };
      rules.push(current);
    } else if (key === "sitemap") {
      sitemaps.push(value);
    } else if (current) {
      if (key === "disallow") current.disallow.push(value);
      if (key === "allow") current.allow.push(value);
    }
  }
  return { rules, sitemaps };
}

/** 某 bot 是否被 robots.txt 封锁（具体 UA 段优先于 * 段；无规则默认放行） */
export function isBotBlocked(rules: RobotsRule[], botTokens: string[]): boolean {
  const hasRules = rules.length > 0;
  if (!hasRules) return false;
  // 具体 UA 段
  for (const r of rules) {
    if (r.userAgents[0] === "*") continue;
    const match = r.userAgents.some((ua) => botTokens.some((t) => t.toLowerCase() === ua.toLowerCase()));
    if (match) return r.disallow.some((d) => d !== "");
  }
  // 全局 * 段
  for (const r of rules) {
    if (r.userAgents[0] === "*") return r.disallow.some((d) => d !== "");
  }
  return false;
}

/* ---------- HTML 内容提取 ---------- */

interface HtmlInfo {
  text: string;
  title: string;
  description: string;
  h1: string[];
  h2: string[];
  jsonLdTypes: string[];
}

export function extractJsonLdTypes(html: string): string[] {
  const types: string[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  /** 递归收集 @type：处理标准 @graph 多实体图 + 常见嵌套容器（mainEntity/itemListElement 等） */
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const t = obj["@type"];
    if (typeof t === "string") types.push(t);
    else if (Array.isArray(t)) types.push(...t.map(String));
    if (Array.isArray(obj["@graph"])) {
      for (const g of obj["@graph"]) walk(g);
      return;
    }
    for (const key of ["mainEntity", "itemListElement", "hasPart"]) {
      const v = obj[key];
      if (Array.isArray(v)) for (const i of v) walk(i);
      else walk(v);
    }
  };

  for (const m of html.matchAll(re)) {
    try {
      walk(JSON.parse(m[1].trim()));
    } catch {
      /* 忽略损坏 JSON-LD */
    }
  }
  return [...new Set(types)];
}

export function extractHtml(html: string): HtmlInfo {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const description =
    (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i)?.[1] ?? "").trim() ||
    (html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i)?.[1] ?? "").trim();
  const h1 = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);
  const h2 = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").trim())
    .filter(Boolean);
  const text = stripped.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  return { text, title, description, h1, h2, jsonLdTypes: extractJsonLdTypes(html) };
}

/* ---------- 审计结果类型 ---------- */

export interface AuditItem {
  id: string;
  label: string;
  max: number;
  score: number;
  status: "pass" | "partial" | "fail";
  detail: string;
}

export interface SiteAudit {
  /** 0-100 结构友好度 */
  score: number;
  items: AuditItem[];
  /** 被 robots 封锁的 AI 爬虫（id 列表） */
  blockedBots: string[];
  /** 纯 HTML 有效字数（AI 爬虫不执行 JS，读到的就是这段） */
  htmlChars: number;
  /** 抓取失败信息 */
  fetchError?: string;
}

export interface AuditAction {
  level: "P0" | "P1" | "P2";
  title: string;
  desc: string;
}

export interface AuditReport {
  id: string;
  createdAt: string;
  inputUrl: string;
  domain: string;
  audit: SiteAudit;
  /** 认知层：AI 认知检测（复用 Identity Engine），慢、可空 */
  check: CheckReport | null;
  actions: AuditAction[];
  /** 综合分：结构 60% + 认知 40%（认知未跑时 = 结构分） */
  score: number;
  verdict: string;
  /** 上一次同域名检测（对比用） */
  prev?: { createdAt: string; auditScore: number; checkScore: number | null; score: number };
}

/* ---------- 评分 ---------- */

/** 检查项权重：从「AI 能不能读懂你」的视角分配 */
const MAX_ROBOTS = 20;
const MAX_CONTENT = 20;
const MAX_LLMS = 15;
const MAX_JSONLD = 20;
const MAX_SITEMAP = 10;
const MAX_META = 15;

async function auditSite(domain: string, baseUrl: string): Promise<SiteAudit> {
  const items: AuditItem[] = [];
  const blockedBots: string[] = [];

  /* --- robots.txt（20）--- */
  const robots = await fetchText(`${baseUrl}/robots.txt`);
  let robotsOk = robots.ok && !robots.text.startsWith("<!doctype") && !robots.text.startsWith("<html");
  let sitemapFromRobots = "";
  let blockedDetail = "未提供 robots.txt（默认放行，但缺少对 AI 爬虫的明确引导）";
  if (robotsOk) {
    const parsed = parseRobots(robots.text);
    sitemapFromRobots = parsed.sitemaps[0] ?? "";
    const bots = loadBots();
    const blocked = bots.filter((b) => isBotBlocked(parsed.rules, b.match));
    for (const b of blocked) blockedBots.push(b.id);
    if (blocked.length === 0) {
      blockedDetail = `robots.txt 可达，${bots.length} 个 AI 爬虫全部放行`;
    } else {
      blockedDetail = `robots.txt 封锁了 ${blocked.length} 个 AI 爬虫：${blocked.map((b) => b.id).join(", ")}`;
    }
  } else if (robots.status === 404) {
    robotsOk = false;
  } else {
    robotsOk = false;
    blockedDetail = robots.error ? `robots.txt 抓取失败：${robots.error}` : `robots.txt 返回异常状态 ${robots.status}`;
  }

  let robotsScore: number;
  let robotsStatus: AuditItem["status"];
  if (blockedBots.length === 0 && robotsOk) {
    robotsScore = MAX_ROBOTS;
    robotsStatus = "pass";
  } else if (blockedBots.length === 0 && !robotsOk && robots.status === 404) {
    robotsScore = 12;
    robotsStatus = "partial";
    blockedDetail = "无 robots.txt（AI 爬虫默认放行，但缺少明确的抓取指引，建议补充）";
  } else if (blockedBots.length === 0) {
    robotsScore = 12;
    robotsStatus = "partial";
  } else {
    robotsScore = Math.max(0, MAX_ROBOTS - 5 * blockedBots.length);
    robotsStatus = "fail";
  }
  items.push({ id: "robots", label: "robots.txt 放行 AI 爬虫", max: MAX_ROBOTS, score: robotsScore, status: robotsStatus, detail: blockedDetail });

  /* --- 首页 HTML 内容（20）--- */
  const page = await fetchText(baseUrl + "/");
  let html: HtmlInfo = { text: "", title: "", description: "", h1: [], h2: [], jsonLdTypes: [] };
  let pageOk = page.ok;
  let pageError = page.error;
  if (page.ok) html = extractHtml(page.text);
  const chars = html.text.replace(/\s+/g, "").length;

  let contentScore: number;
  let contentStatus: AuditItem["status"];
  let contentDetail: string;
  if (!pageOk) {
    contentScore = 0;
    contentStatus = "fail";
    contentDetail = `首页抓取失败：${pageError ?? `状态 ${page.status}`}`;
  } else if (chars >= 300) {
    contentScore = MAX_CONTENT;
    contentStatus = "pass";
    contentDetail = `纯 HTML 可读内容 ${chars} 字——AI 爬虫不用执行 JS 就能读到，友好`;
  } else if (chars >= 100) {
    contentScore = 14;
    contentStatus = "partial";
    contentDetail = `纯 HTML 可读内容 ${chars} 字，偏薄（AI 爬虫大多不执行 JS，可能读不到 JS 渲染的内容）`;
  } else if (chars >= 30) {
    contentScore = 8;
    contentStatus = "partial";
    contentDetail = `纯 HTML 可读内容仅 ${chars} 字——疑似 JS 渲染空壳，AI 爬虫几乎读不到内容`;
  } else {
    contentScore = 0;
    contentStatus = "fail";
    contentDetail = "纯 HTML 几乎没有可读文字——这是最严重的问题，AI 爬虫不执行 JS，读到的就是空壳";
  }
  items.push({ id: "content", label: "纯 HTML 可读内容量（AI 视角）", max: MAX_CONTENT, score: contentScore, status: contentStatus, detail: contentDetail });

  /* --- llms.txt（15）--- */
  const llms = await fetchText(`${baseUrl}/llms.txt`);
  const llmsChars = llms.ok ? llms.text.replace(/\s+/g, "").length : 0;
  let llmsScore: number;
  let llmsStatus: AuditItem["status"];
  let llmsDetail: string;
  if (llms.ok && llmsChars >= 50) {
    llmsScore = MAX_LLMS;
    llmsStatus = "pass";
    llmsDetail = `llms.txt 存在（${llmsChars} 字），AI 有现成的知识入口`;
  } else if (llms.ok && llmsChars > 0) {
    llmsScore = 8;
    llmsStatus = "partial";
    llmsDetail = `llms.txt 存在但内容过薄（${llmsChars} 字），信息量不足`;
  } else {
    llmsScore = 0;
    llmsStatus = "fail";
    llmsDetail = "无 llms.txt——AI 的知识入口缺失（GEO 第一优先补齐项之一）";
  }
  items.push({ id: "llms", label: "llms.txt 知识入口", max: MAX_LLMS, score: llmsScore, status: llmsStatus, detail: llmsDetail });

  /* --- JSON-LD 结构化数据（20）--- */
  const jsonTypes = html.jsonLdTypes;
  const keyTypes = ["Organization", "WebSite", "Person", "FAQPage", "BreadcrumbList", "Product", "LocalBusiness", "ProfessionalService"];
  const hitKey = jsonTypes.filter((t) => keyTypes.includes(t));
  let jsonScore: number;
  let jsonStatus: AuditItem["status"];
  let jsonDetail: string;
  if (hitKey.length > 0) {
    jsonScore = MAX_JSONLD;
    jsonStatus = "pass";
    jsonDetail = `含结构化数据：${hitKey.join(", ")}——AI 能读懂你的身份`;
  } else if (jsonTypes.length > 0) {
    jsonScore = 10;
    jsonStatus = "partial";
    jsonDetail = `有 JSON-LD，但缺关键类型（Organization/FAQPage 等）：当前 ${jsonTypes.join(", ") || "无"}`;
  } else {
    jsonScore = 0;
    jsonStatus = "fail";
    jsonDetail = "无 JSON-LD 结构化数据，AI 需要自己猜你的身份";
  }
  items.push({ id: "jsonld", label: "JSON-LD 结构化数据", max: MAX_JSONLD, score: jsonScore, status: jsonStatus, detail: jsonDetail });

  /* --- sitemap.xml（10）--- */
  const sitemapCandidates = [sitemapFromRobots || `${baseUrl}/sitemap.xml`];
  let sitemapScore = 0;
  let sitemapStatus: AuditItem["status"] = "fail";
  let sitemapDetail = "无 sitemap.xml——AI 爬虫少一张全站地图";
  for (const smUrl of sitemapCandidates) {
    const sm = await fetchText(smUrl);
    const looksXml = sm.ok && /<urlset|<sitemapindex/i.test(sm.text);
    if (looksXml) {
      const urlCount = (sm.text.match(/<url>/g) || []).length + (sm.text.match(/<sitemap>/g) || []).length;
      sitemapScore = MAX_SITEMAP;
      sitemapStatus = "pass";
      sitemapDetail = `sitemap 存在（约 ${urlCount} 条 URL），地图齐全`;
      break;
    }
  }
  items.push({ id: "sitemap", label: "sitemap.xml 站点地图", max: MAX_SITEMAP, score: sitemapScore, status: sitemapStatus, detail: sitemapDetail });

  /* --- title / meta description / heading（15）--- */
  let metaScore = 0;
  const metaParts: string[] = [];
  if (html.title) {
    metaScore += 5;
    metaParts.push(`<title> ✓`);
  } else metaParts.push(`<title> ✗`);
  if (html.description) {
    metaScore += 5;
    metaParts.push(`meta description ✓`);
  } else metaParts.push(`meta description ✗`);
  if (html.h1.length > 0) {
    metaScore += 5;
    metaParts.push(`H1 ✓`);
  } else metaParts.push(`H1 ✗`);
  const metaStatus: AuditItem["status"] = metaScore === MAX_META ? "pass" : metaScore > 0 ? "partial" : "fail";
  const headingHint = html.h2.length > 0 ? `（H2×${html.h2.length}）` : "";
  items.push({
    id: "meta",
    label: "title / meta / 标题结构",
    max: MAX_META,
    score: metaScore,
    status: metaStatus,
    detail: `${metaParts.join(" · ")}${headingHint}${metaScore < MAX_META ? "——AI 靠这些理解页面主题" : ""}`,
  });

  const total = items.reduce((s, i) => s + i.score, 0);

  return {
    score: total,
    items,
    blockedBots,
    htmlChars: chars,
    ...(pageError ? { fetchError: pageError } : {}),
  };
}

/* ---------- 行动清单 ---------- */

function buildActions(audit: SiteAudit, check: CheckReport | null): AuditAction[] {
  const actions: AuditAction[] = [];
  const byId = new Map(audit.items.map((i) => [i.id, i]));

  // P0：AI 根本读不到 / 进不来
  const content = byId.get("content");
  if (content && content.status !== "pass" && audit.htmlChars < 100) {
    actions.push({
      level: "P0",
      title: "网站是 JS 渲染空壳，AI 读不到内容",
      desc: `纯 HTML 只有 ${audit.htmlChars} 字。AI 爬虫大多不执行 JavaScript，读到的就是空壳。改为 SSR/预渲染，或在 HTML 里放真实可读的文字（正文、介绍、FAQ）。`,
    });
  }
  const robots = byId.get("robots");
  if (robots && robots.status === "fail") {
    actions.push({
      level: "P0",
      title: `robots.txt 封锁了 ${audit.blockedBots.length} 个 AI 爬虫`,
      desc: `被挡：${audit.blockedBots.join(", ")}。这些爬虫进不来，AI 永远看不到你。放开对 AI 爬虫的访问（或只挡广告爬虫）。`,
    });
  }

  // P1：知识入口缺失
  const llms = byId.get("llms");
  if (llms && llms.status !== "pass") {
    actions.push({
      level: "P1",
      title: "补齐 llms.txt——AI 的知识入口",
      desc: "在根目录放 llms.txt：你是谁、提供什么、关键链接（官网/博客/FAQ）。这是 AI 直接读懂你最快的通道。",
    });
  }
  const jsonld = byId.get("jsonld");
  if (jsonld && jsonld.status !== "pass") {
    actions.push({
      level: "P1",
      title: "加 JSON-LD 结构化数据（身份卡）",
      desc: "首页放 Organization/WebSite Schema（名称、logo、官网、简介），有 FAQ 就加 FAQPage。AI 靠它读懂你的身份。",
    });
  }

  // P2：地图与元信息
  const sitemap = byId.get("sitemap");
  if (sitemap && sitemap.status !== "pass") {
    actions.push({
      level: "P2",
      title: "加 sitemap.xml 站点地图",
      desc: "生成全站 URL 地图放到 /sitemap.xml，并在 robots.txt 里声明 Sitemap 指向它，让 AI 爬虫少走弯路。",
    });
  }
  const meta = byId.get("meta");
  if (meta && meta.status !== "pass") {
    actions.push({
      level: "P2",
      title: "补全 title / meta description / H1",
      desc: "每个页面：唯一 title、一句话 meta description、清晰的 H1 + H2 层级。AI 靠这些理解页面主题。",
    });
  }

  // 认知层补充（有检测结果且低分时）
  if (check && check.score < 60) {
    actions.push({
      level: "P1",
      title: `AI 认知偏低（${check.score}/100）`,
      desc: `AI 说「${check.verdict}」。结构补上后复测；若仍不认识，需要在知乎/公众号/GitHub 等高权重平台产出同口径内容（品牌名 + 一句话定位）。`,
    });
  }

  return actions.slice(0, 6);
}

/* ---------- 历史存储（data/audits.jsonl） ---------- */

export function appendAudit(report: AuditReport): void {
  mkdirSync(path.dirname(AUDITS_FILE), { recursive: true });
  appendFileSync(AUDITS_FILE, JSON.stringify(report) + "\n", "utf-8");
}

export function listAudits(limit = 20): AuditReport[] {
  if (!existsSync(AUDITS_FILE)) return [];
  const lines = readFileSync(AUDITS_FILE, "utf-8").split("\n").filter(Boolean);
  const out: AuditReport[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      out.push(JSON.parse(lines[i]) as AuditReport);
    } catch {
      /* 跳过损坏行 */
    }
  }
  return out;
}

/** 取同域名最近一次历史（对比用） */
function lastAuditFor(domain: string): AuditReport["prev"] | undefined {
  const all = listAudits(100);
  for (const a of all) {
    if (a.domain === domain) {
      return {
        createdAt: a.createdAt,
        auditScore: a.audit.score,
        checkScore: a.check?.score ?? null,
        score: a.score,
      };
    }
  }
  return undefined;
}

/* ---------- 主流程：跑一次完整闭环 ---------- */

/**
 * 输入 URL → ①结构审计（秒级）→ ②AI 认知检测（复用 check.ts）→ ③行动清单 → 存历史
 */
export async function runAudit(inputUrl: string, opts: { withCheck?: boolean } = {}): Promise<AuditReport> {
  const { domain, baseUrl } = normalizeDomain(inputUrl);
  const audit = await auditSite(domain, baseUrl);

  let check: CheckReport | null = null;
  if (opts.withCheck !== false) {
    try {
      check = await runCheck(domain);
    } catch (e) {
      console.error("[审计] AI 认知检测失败：", e);
    }
  }

  const actions = buildActions(audit, check);
  const score = check ? Math.round(audit.score * 0.6 + check.score * 0.4) : audit.score;
  const verdict =
    score >= 80 ? "AI 友好度高" : score >= 60 ? "基本友好，有缺口" : score >= 40 ? "缺口明显，AI 难读懂" : "对 AI 很不友好";

  const report: AuditReport = {
    id: Date.now().toString(36),
    createdAt: new Date().toISOString(),
    inputUrl: inputUrl.trim(),
    domain,
    audit,
    check,
    actions,
    score,
    verdict,
    prev: lastAuditFor(domain),
  };

  appendAudit(report);
  return report;
}
