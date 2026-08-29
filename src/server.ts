import "dotenv/config";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCheck } from "./check.js";
import { runAudit, listAudits } from "./audit.js";
import { appendCheck, listChecks, getCheck } from "./history.js";
import { generateKB, getKB, saveKB, listKBs, runGapAnalysis, type KBInput } from "./kb.js";
import {
  Anchor,
  PLATFORMS,
  defaultAnchor,
  generateVersions,
  siteSnippet,
  loadAnchor,
  saveAnchor,
} from "./anchor.js";
import {
  Article,
  checkArticles,
  loadArticles,
  saveArticles,
} from "./articles.js";
import { runCompare, runSceneCompare, type SceneCompareReport } from "./compare.js";
import { attachCheck, attachCiteCitation, attachSceneShares, entityStats, loadEntities } from "./entity.js";
import { checkCites, loadCites, saveCites, type CiteSite } from "./cite.js";
import { buildLeaderboard } from "./leaderboard.js";
import { receiveObserve, detectBot, isObservedSite, appendEvents } from "./observe.js";
import {
  generatePlan,
  loadLedger,
  getPack,
  updatePack,
  renderExportText,
  type PackStatus,
} from "./pack.js";
import {
  authenticate,
  getToken,
  syncAllResources,
  submitOrder,
  parseCallback,
  type CallbackItem,
} from "./softwen-api.js";
import { selectMedia, renderSelection, type ScoredMedia } from "./media-selector.js";
import { writeAllArticles, type WriteResult } from "./ai-writer.js";
import { buildEffectMatrix, recommendForIndustry } from "./effect.js";

/**
 * AI 可见度检测 — 公网产品服务端
 * 零依赖 Node http。页面在 src/web/index.html（独立文件）。
 *
 *  `POST /api/check`  {query} → 运行一次检测，落盘历史，返回报告
 *  `GET  /api/checks` → 最近检测历史（新的在前）
 *  `GET  /`           → 产品页面
 *
 * 公网安全：按 IP 限流 + 全局并发上限 + 输入长度校验 + 统一错误 JSON。
 *  API key 只存在于服务端 .env，使用者无需任何配置。
 */

const PORT = Number(process.env.PORT || 8788);
const here = process.cwd();
const pageFile = path.join(here, "src/web/index.html");
const appPageFile = path.join(here, "src/web/app.html");
const reportPageFile = path.join(here, "src/web/report.html");
const deployPageFile = path.join(here, "src/web/deploy.html");
const packPageFile = path.join(here, "src/web/packs.html");
const auditPageFile = path.join(here, "src/web/audit.html");

/** HTML 页面响应头：强制 no-cache（内容随开发持续变化，避免浏览器/CDN 展示旧版本） */
const htmlHeaders = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" };

/** 每 IP 限流：X 次 / 分钟，Y 次 / 天 */
const PER_MIN = Number(process.env.RATE_PER_MIN || 8);
const PER_DAY = Number(process.env.RATE_PER_DAY || 80);
/** 全局并发检测上限（每检测 = 2-4 次外部 API 调用，防止被刷爆） */
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 3);

const minHits = new Map<string, number[]>(); // ip -> 最近请求时间戳（分钟窗）
const dayHits = new Map<string, number[]>(); // ip -> 最近请求时间戳（天窗）

function clientIP(req: import("node:http").IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

/** 滑动窗口限流；返回剩余可用次数 */
function allow(ip: string): { ok: boolean; retryAfterSec?: number } {
  const now = Date.now();
  for (const [map, windowMs, max] of [
    [minHits, 60_000, PER_MIN],
    [dayHits, 86_400_000, PER_DAY],
  ] as [Map<string, number[]>, number, number][]) {
    const arr = (map.get(ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      const wait = Math.ceil((arr[0] + windowMs - now) / 1000);
      return { ok: false, retryAfterSec: Math.max(wait, 1) };
    }
    arr.push(now);
    map.set(ip, arr);
  }
  return { ok: true };
}

function json(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

let runningChecks = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // ============ 来访观测（输入侧）：识别 AI 爬虫 UA → 异步落本地事件（永不阻塞主流程） ============
  const botId = detectBot(req.headers["user-agent"] ?? "");
  const host = String(req.headers.host ?? "").toLowerCase().replace(/^www\./, "").split(":")[0];
  if (botId && isObservedSite(host)) {
    queueMicrotask(() =>
      appendEvents({ site: host, bot_id: botId, url: (url.pathname + url.search).slice(0, 512), ts: Date.now() })
    );
  }

  // 静态页
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, htmlHeaders);
    res.end(readFileSync(pageFile, "utf-8"));
    return;
  }

  // 企业私有部署定制页
  if (req.method === "GET" && url.pathname === "/deploy") {
    res.writeHead(200, htmlHeaders);
    res.end(readFileSync(deployPageFile, "utf-8"));
    return;
  }

  // 控制台页（方案 A：营销官网 / 与产品操作台 /app 分离）
  if (req.method === "GET" && (url.pathname === "/app" || url.pathname === "/app/")) {
    res.writeHead(200, htmlHeaders);
    res.end(readFileSync(appPageFile, "utf-8"));
    return;
  }

  // 独立报告页（/report/{id}，从历史读出）
  const reportMatch = url.pathname.match(/^\/report\/([a-z0-9]+)$/i);
  if (req.method === "GET" && reportMatch) {
    const id = reportMatch[1];
    if (!getCheck(id)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("报告不存在或已过期");
      return;
    }
    res.writeHead(200, htmlHeaders);
    res.end(readFileSync(reportPageFile, "utf-8"));
    return;
  }

  // 品牌 logo（桌面 logo 文件夹定稿：SVG 矢量 + PNG 透明）
  if (req.method === "GET" && (url.pathname === "/logo.svg" || url.pathname === "/logo.png" || url.pathname === "/logo-final.png")) {
    const isSvg = url.pathname.endsWith(".svg");
    res.writeHead(200, { "Content-Type": isSvg ? "image/svg+xml" : "image/png", "Cache-Control": "public, max-age=3600" });
    res.end(readFileSync(path.join(here, isSvg ? "src/web/logo.svg" : "src/web/logo-final.png")));
    return;
  }

  // logo 原图（1254px 高清，点击放大 lightbox 用）
  if (req.method === "GET" && url.pathname === "/logo-original.png") {
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" });
    res.end(readFileSync(path.join(here, "src/web/logo-original.png")));
    return;
  }

  // AI 爬虫来访事件接收器（鉴权写入口：zkoner.com 等站点边缘中间件上报）
  if (url.pathname === "/api/observe") {
    if (req.method === "GET") {
      json(res, 200, { ok: true, service: "observe", hint: "POST events with Bearer token" });
      return;
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const r = receiveObserve(body, req.headers["authorization"] ?? "");
      json(res, r.status, r.body);
      return;
    }
  }

  // 可见度公示 · 实体可见度数据（内部聚合，供 hero 榜卡片引用）
  if (req.method === "GET" && url.pathname === "/api/leaderboard") {
    json(res, 200, { ok: true, board: buildLeaderboard() });
    return;
  }

  // 检测历史
  if (req.method === "GET" && url.pathname === "/api/checks") {
    const limit = Math.min(Number(url.searchParams.get("limit") || 20), 50);
    json(res, 200, { ok: true, checks: listChecks(limit) });
    return;
  }

  // 单条检测报告（独立报告页数据）
  const checkMatch = url.pathname.match(/^\/api\/checks\/([a-z0-9]+)$/i);
  if (req.method === "GET" && checkMatch) {
    const report = getCheck(checkMatch[1]);
    if (!report) {
      json(res, 404, { ok: false, message: "报告不存在或已过期" });
      return;
    }
    json(res, 200, { ok: true, report });
    return;
  }

  // 运行检测
  if (req.method === "POST" && url.pathname === "/api/check") {
    let body: { query?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { ok: false, message: "请求体不是合法 JSON" });
      return;
    }
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      json(res, 400, { ok: false, message: "请输入品牌名、网站或问题" });
      return;
    }
    if (query.length > 200) {
      json(res, 400, { ok: false, message: "输入过长（最多 200 字）" });
      return;
    }

    const ip = clientIP(req);
    const lim = allow(ip);
    if (!lim.ok) {
      json(res, 429, { ok: false, message: `请求太频繁，请 ${lim.retryAfterSec} 秒后再试`, retryAfterSec: lim.retryAfterSec });
      return;
    }
    if (runningChecks >= MAX_CONCURRENT) {
      json(res, 429, { ok: false, message: "当前检测人数较多，请稍后再试" });
      return;
    }

    runningChecks++;
    try {
      const report = await runCheck(query);
      appendCheck(report);
      attachCheck(report); // 统一实体层：品牌/域名检测自动进实体档案
      json(res, 200, { ok: true, report });
    } catch (e) {
      console.error("[检测] 运行失败：", e);
      json(res, 500, { ok: false, message: "检测服务暂时不可用，请稍后再试" });
    } finally {
      runningChecks--;
    }
    return;
  }

  // ============ 站点 AI 友好度审计（闭环第一层） ============

  // 审计页面（一个输入框）
  if (req.method === "GET" && url.pathname === "/audit") {
    res.writeHead(200, htmlHeaders);
    res.end(readFileSync(auditPageFile, "utf-8"));
    return;
  }

  // 审计历史
  if (req.method === "GET" && url.pathname === "/api/audits") {
    const limit = Math.min(Number(url.searchParams.get("limit") || 20), 50);
    json(res, 200, { ok: true, audits: listAudits(limit) });
    return;
  }

  // 跑一次闭环：输入 URL → ①结构审计 ②AI 认知 ③行动清单 ④历史对比
  if (req.method === "POST" && url.pathname === "/api/audit") {
    let body: { url?: unknown; withCheck?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { ok: false, message: "请求体不是合法 JSON" });
      return;
    }
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) {
      json(res, 400, { ok: false, message: "请输入网站地址，如 geoloopos.com" });
      return;
    }
    if (url.length > 200) {
      json(res, 400, { ok: false, message: "输入过长（最多 200 字）" });
      return;
    }

    const ip = clientIP(req);
    const lim = allow(ip);
    if (!lim.ok) {
      json(res, 429, { ok: false, message: `请求太频繁，请 ${lim.retryAfterSec} 秒后再试`, retryAfterSec: lim.retryAfterSec });
      return;
    }
    if (runningChecks >= MAX_CONCURRENT) {
      json(res, 429, { ok: false, message: "当前检测人数较多，请稍后再试" });
      return;
    }

    runningChecks++;
    try {
      const withCheck = body.withCheck !== false;
      const report = await runAudit(url, { withCheck });
      json(res, 200, { ok: true, report });
    } catch (e) {
      console.error("[审计] 运行失败：", e);
      const msg = e instanceof Error ? e.message : "审计失败，请稍后再试";
      json(res, 400, { ok: false, message: msg });
    } finally {
      runningChecks--;
    }
    return;
  }

  // ============ 定位锚点 ============
  if (req.method === "GET" && url.pathname === "/api/anchor") {
    const a = loadAnchor();
    json(res, 200, {
      ok: true,
      anchor: a,
      platforms: PLATFORMS,
      versions: generateVersions(a),
      snippet: siteSnippet(a),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/anchor") {
    let body: { anchor?: Partial<Anchor> };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { ok: false, message: "请求体不是合法 JSON" });
      return;
    }
    const cur = loadAnchor();
    const next: Anchor = {
      name: String(body.anchor?.name ?? cur.name).trim(),
      positioning: String(body.anchor?.positioning ?? cur.positioning).trim(),
      keywords: (Array.isArray(body.anchor?.keywords) ? body.anchor!.keywords! : cur.keywords)
        .map((k) => String(k).trim())
        .filter(Boolean),
      site: String(body.anchor?.site ?? cur.site).trim(),
      bio: String(body.anchor?.bio ?? cur.bio ?? "").trim(),
    };
    saveAnchor(next);
    json(res, 200, {
      ok: true,
      anchor: next,
      platforms: PLATFORMS,
      versions: generateVersions(next),
      snippet: siteSnippet(next),
    });
    return;
  }

  // ============ 知识库 · 结构化信息生成 ============
  if (req.method === "GET" && url.pathname === "/api/kb") {
    json(res, 200, { ok: true, kbs: listKBs() });
    return;
  }

  const kbGetMatch = url.pathname.match(/^\/api\/kb\/([^/]+)$/);
  if (req.method === "GET" && kbGetMatch) {
    const kb = getKB(decodeURIComponent(kbGetMatch[1]));
    if (!kb) {
      json(res, 404, { ok: false, message: "知识库条目不存在" });
      return;
    }
    json(res, 200, { ok: true, kb });
    return;
  }

  // 生成/保存知识卡（LLM 结构化整理，失败自动回退确定性组装）
  if (req.method === "POST" && url.pathname === "/api/kb") {
    let body: { input?: Partial<KBInput> };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { ok: false, message: "请求体不是合法 JSON" });
      return;
    }
    const input = body.input || {};
    const name = String(input.name ?? "").trim();
    if (!name) {
      json(res, 400, { ok: false, message: "名称必填" });
      return;
    }
    if (name.length > 40) {
      json(res, 400, { ok: false, message: "名称过长（最多 40 字）" });
      return;
    }
    const kb = await generateKB(input as KBInput);
    saveKB(kb);
    json(res, 200, { ok: true, kb });
    return;
  }

  // 知识缺口分析：跑一次检测，把知识卡事实与 AI 认知比对
  if (req.method === "POST" && url.pathname === "/api/kb/gap") {
    let body: { key?: string };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { ok: false, message: "请求体不是合法 JSON" });
      return;
    }
    const key = String(body.key ?? "").trim();
    const kb = getKB(key);
    if (!kb) {
      json(res, 404, { ok: false, message: "知识库条目不存在，请先生成" });
      return;
    }
    if (kb.facts.length === 0) {
      json(res, 400, { ok: false, message: "知识卡还没有「关键事实」，先在表单里填几行事实" });
      return;
    }
    const ip = clientIP(req);
    const lim = allow(ip);
    if (!lim.ok) {
      json(res, 429, { ok: false, message: `请求太频繁，请 ${lim.retryAfterSec} 秒后再试`, retryAfterSec: lim.retryAfterSec });
      return;
    }
    if (runningChecks >= MAX_CONCURRENT) {
      json(res, 429, { ok: false, message: "当前检测人数较多，请稍后再试" });
      return;
    }
    runningChecks++;
    try {
      const gap = await runGapAnalysis(kb);
      const fresh = { ...kb, gap };
      saveKB(fresh);
      json(res, 200, { ok: true, gap, kb: fresh });
    } catch (e) {
      console.error("[知识缺口] 运行失败：", e);
      json(res, 500, { ok: false, message: "缺口分析暂时不可用，请稍后再试" });
    } finally {
      runningChecks--;
    }
    return;
  }

  // ============ 文章库 / 文章监测 ============
  if (req.method === "GET" && url.pathname === "/api/articles") {
    json(res, 200, { ok: true, articles: loadArticles() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/articles") {
    let body: { title?: unknown; url?: unknown; topic?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { ok: false, message: "请求体不是合法 JSON" });
      return;
    }
    const title = String(body.title ?? "").trim();
    const url = String(body.url ?? "").trim();
    const topic = String(body.topic ?? "").trim();
    if (!title || !url) {
      json(res, 400, { ok: false, message: "标题和文章 URL 必填" });
      return;
    }
    if (title.length > 120 || url.length > 500 || topic.length > 60) {
      json(res, 400, { ok: false, message: "字段过长" });
      return;
    }
    const list = loadArticles();
    const article: Article = { id: Date.now().toString(36), title, url, topic: topic || title, createdAt: new Date().toISOString() };
    list.push(article);
    saveArticles(list);
    json(res, 200, { ok: true, article, articles: list });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/articles/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const list = loadArticles();
    const next = list.filter((a) => a.id !== id);
    saveArticles(next);
    json(res, 200, { ok: true, articles: next });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/articles/check") {
    const ip = clientIP(req);
    const lim = allow(ip);
    if (!lim.ok) {
      json(res, 429, { ok: false, message: `请求太频繁，请 ${lim.retryAfterSec} 秒后再试` });
      return;
    }
    if (runningChecks >= MAX_CONCURRENT) {
      json(res, 429, { ok: false, message: "当前检测人数较多，请稍后再试" });
      return;
    }
    const list = loadArticles();
    if (!list.length) {
      json(res, 400, { ok: false, message: "文章库为空，先添加文章" });
      return;
    }
    runningChecks++;
    try {
      const updated = await checkArticles(list);
      saveArticles(updated);
      json(res, 200, { ok: true, articles: updated });
    } catch (e) {
      console.error("[文章监测] 失败：", e);
      json(res, 500, { ok: false, message: "文章监测失败，请稍后再试" });
    } finally {
      runningChecks--;
    }
    return;
  }

  // ============ 引用追踪 · 域名追踪 ============
  if (req.method === "GET" && url.pathname === "/api/cites") {
    json(res, 200, { ok: true, sites: loadCites() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cites") {
    let body: { domain?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { ok: false, message: "请求体不是合法 JSON" });
      return;
    }
    const raw = String(body.domain ?? "").trim().toLowerCase();
    const m = raw.match(/^(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,})$/);
    if (!m) {
      json(res, 400, { ok: false, message: "请输入合法域名，如 example.com" });
      return;
    }
    const domain = m[1];
    const list = loadCites();
    if (list.some((s) => s.domain === domain)) {
      json(res, 400, { ok: false, message: "该域名已在追踪中" });
      return;
    }
    const site: CiteSite = { id: Date.now().toString(36), domain, createdAt: new Date().toISOString(), checks: [] };
    list.push(site);
    saveCites(list);
    json(res, 200, { ok: true, sites: list });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/cites/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const next = loadCites().filter((s) => s.id !== id);
    saveCites(next);
    json(res, 200, { ok: true, sites: next });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cites/check") {
    const ip = clientIP(req);
    const lim = allow(ip);
    if (!lim.ok) {
      json(res, 429, { ok: false, message: `请求太频繁，请 ${lim.retryAfterSec} 秒后再试` });
      return;
    }
    if (runningChecks >= MAX_CONCURRENT) {
      json(res, 429, { ok: false, message: "当前检测人数较多，请稍后再试" });
      return;
    }
    const list = loadCites();
    if (!list.length) {
      json(res, 400, { ok: false, message: "还没添加域名，先加入要追踪的站点" });
      return;
    }
    runningChecks++;
    try {
      const updated = await checkCites(list);
      saveCites(updated);
      for (const site of updated) {
        const last = site.checks[site.checks.length - 1];
        if (last && last.cited && last.sources.length) attachCiteCitation(site.domain, last.checkedAt, last.sources);
      }
      json(res, 200, { ok: true, sites: updated });
    } catch (e) {
      console.error("[域名追踪] 失败：", e);
      json(res, 500, { ok: false, message: "域名追踪失败，请稍后再试" });
    } finally {
      runningChecks--;
    }
    return;
  }

  // ============ 统一实体层（数据底座） ============
  if (req.method === "GET" && url.pathname === "/api/entities") {
    json(res, 200, { ok: true, entities: loadEntities() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/entities/stats") {
    json(res, 200, { ok: true, stats: entityStats() });
    return;
  }

  // ============ 竞品对比 ============
  if (req.method === "POST" && url.pathname === "/api/compare") {
    let body: { self?: unknown; competitors?: unknown; scene?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { ok: false, message: "请求体不是合法 JSON" });
      return;
    }
    const self = String(body.self ?? "").trim();
    const scene = String(body.scene ?? "").trim();
    const competitors = Array.isArray(body.competitors)
      ? body.competitors.map((c) => String(c).trim()).filter(Boolean).slice(0, 5)
      : [];
    if (!self) {
      json(res, 400, { ok: false, message: "请输入你的品牌名" });
      return;
    }
    if (self.length > 80) {
      json(res, 400, { ok: false, message: "品牌名过长" });
      return;
    }
    if (scene.length > 120) {
      json(res, 400, { ok: false, message: "场景问题过长（最多 120 字）" });
      return;
    }

    const ip = clientIP(req);
    const lim = allow(ip);
    if (!lim.ok) {
      json(res, 429, { ok: false, message: `请求太频繁，请 ${lim.retryAfterSec} 秒后再试` });
      return;
    }
    if (runningChecks >= MAX_CONCURRENT) {
      json(res, 429, { ok: false, message: "当前检测人数较多，请稍后再试" });
      return;
    }

    runningChecks++;
    try {
      const report = scene ? await runSceneCompare(scene, [self, ...competitors]) : await runCompare(self, competitors);
      if (scene) attachSceneShares(report as SceneCompareReport); // 统一实体层：场景份额落盘
      json(res, 200, { ok: true, ...report });
    } catch (e) {
      console.error("[竞品对比] 失败：", e);
      json(res, 500, { ok: false, message: "对比失败，请稍后再试" });
    } finally {
      runningChecks--;
    }
    return;
  }

  // ============ 软文需求单（软文街·软文宝接入） ============
  if (req.method === "GET" && url.pathname === "/packs") {
    res.writeHead(200, htmlHeaders);
    res.end(readFileSync(packPageFile, "utf-8"));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/packs") {
    const records = loadLedger().reverse(); // 新的在前
    json(res, 200, { ok: true, records });
    return;
  }

  // 生成需求单（精确路径优先，避免被下面的 {id} 吞掉 "generate"）
  if (req.method === "POST" && url.pathname === "/api/packs/generate") {
    let body: { entity?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { ok: false, message: "请求体不是合法 JSON" });
      return;
    }
    const entity = String(body.entity ?? "").trim();
    const plan = generatePlan(entity ? { entity } : {});
    json(res, 200, { ok: true, plan, exportText: renderExportText(plan) });
    return;
  }

  const packMatch = url.pathname.match(/^\/api\/packs\/([a-z0-9-]+)$/i);
  if (req.method === "GET" && packMatch) {
    const record = getPack(packMatch[1]);
    if (!record) {
      json(res, 404, { ok: false, message: "需求单不存在" });
      return;
    }
    json(res, 200, { ok: true, record, exportText: renderExportText(record.plan) });
    return;
  }

  if (req.method === "POST" && packMatch) {
    let body: { status?: unknown; notes?: unknown; publications?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { ok: false, message: "请求体不是合法 JSON" });
      return;
    }
    const patch: { status?: PackStatus; notes?: string; publications?: { title: string; channel: string; url: string; collected: boolean; reads: number; publishedAt: string; orderId?: string }[] } = {};
    if (body.status === "planned" || body.status === "exported" || body.status === "published") patch.status = body.status;
    if (typeof body.notes === "string") patch.notes = body.notes.slice(0, 2000);
    if (Array.isArray(body.publications)) {
      patch.publications = body.publications
        .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
        .slice(0, 50)
        .map((p) => ({
          title: String(p.title ?? "").slice(0, 200),
          channel: String(p.channel ?? "").slice(0, 100),
          url: String(p.url ?? "").slice(0, 500),
          collected: Boolean(p.collected),
          reads: Number(p.reads) > 0 ? Math.floor(Number(p.reads)) : 0,
          publishedAt: String(p.publishedAt ?? "").slice(0, 40),
          orderId: String(p.orderId ?? "").slice(0, 60),
        }));
    }
    const record = updatePack(packMatch[1], patch);
    if (!record) {
      json(res, 404, { ok: false, message: "需求单不存在" });
      return;
    }
    json(res, 200, { ok: true, record });
    return;
  }

  // ============ 软文街 API 接入（选媒体 / 下单 / 回调 / 写稿） ============

  // GET /api/softwen/stats — 媒体资源占比统计（自媒体/门户/收录类型/权重分层）
  if (req.method === "GET" && url.pathname === "/api/softwen/stats") {
    try {
      const fs = await import("node:fs");
      const file = path.join(here, "data/softwen/stats.json");
      if (fs.existsSync(file)) {
        json(res, 200, { ok: true, stats: JSON.parse(fs.readFileSync(file, "utf-8")) });
      } else {
        json(res, 404, { ok: false, message: "媒体统计未生成，先跑 scripts/sync-softwen-resources.mjs 拉全量资源" });
      }
    } catch (e) {
      json(res, 500, { ok: false, message: "读取统计失败：" + (e as Error).message });
    }
    return;
  }

  // GET /api/softwen/resources — 查媒体（可带 page/topN/关键词/地区/是否外链 筛选），从本地缓存读
  if (req.method === "GET" && url.pathname === "/api/softwen/resources") {
    try {
      const q = new URL(req.url!, "http://localhost").searchParams;
      const fs = await import("node:fs");
      const file = path.join(here, "data/softwen/resources.jsonl");
      if (!fs.existsSync(file)) {
        json(res, 404, { ok: false, message: "媒体资源未同步，先跑 scripts/sync-softwen-resources.mjs" });
        return;
      }
      const topN = Math.min(50, Math.max(1, Number(q.get("topN") || 10)));
      const picks = selectMedia({
        topN,
        maxPrice: Number(q.get("maxPrice") || 200) || 200,
        requireLink: q.get("requireLink") === "1",
        // 默认排除自媒体（is_zimeiti=1），只发门户/行业站；includeZimeiti=1 可显式放开
        excludeZimeiti: q.get("includeZimeiti") !== "1",
        includeTypes: q.get("includeTypes")?.split(",") || ["新闻源收录", "网页收录"],
        keywords: q.get("keywords")?.split(",").filter(Boolean),
        area: q.get("area") || undefined,
      }, file);
      json(res, 200, { ok: true, picks, count: picks.length });
    } catch (e) {
      json(res, 500, { ok: false, message: "查询媒体失败：" + (e as Error).message });
    }
    return;
  }

  // POST /api/softwen/sync — 触发全量同步媒体资源（后台跑，可能几分钟）
  if (req.method === "POST" && url.pathname === "/api/softwen/sync") {
    try {
      syncAllResources().then((n) => console.log(`[softwen] 全量同步完成，共 ${n} 条`)).catch((e) => console.error("[softwen] 同步失败:", e.message));
      json(res, 202, { ok: true, message: "媒体资源同步已启动，后台进行中" });
    } catch (e) {
      json(res, 500, { ok: false, message: "启动同步失败：" + (e as Error).message });
    }
    return;
  }

  // POST /api/softwen/write — 用 DeepSeek 为某需求单写全平台稿件
  if (req.method === "POST" && url.pathname === "/api/softwen/write") {
    let body: { id?: unknown };
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { ok: false, message: "请求体不是合法 JSON" }); return; }
    const record = getPack(String(body.id ?? ""));
    if (!record) { json(res, 404, { ok: false, message: "需求单不存在" }); return; }
    try {
      const articles: WriteResult[] = await writeAllArticles(record.plan);
      json(res, 200, { ok: true, articles });
    } catch (e) {
      json(res, 500, { ok: false, message: "AI 写稿失败：" + (e as Error).message });
    }
    return;
  }

  // POST /api/softwen/submit — 从需求单发稿：写稿(可选) + 选媒体 + 下单 + 回填台账
  if (req.method === "POST" && url.pathname === "/api/softwen/submit") {
    let body: { id?: unknown; contentHtml?: unknown; resourceIds?: unknown; title?: unknown };
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { ok: false, message: "请求体不是合法 JSON" }); return; }
    const record = getPack(String(body.id ?? ""));
    if (!record) { json(res, 404, { ok: false, message: "需求单不存在" }); return; }

    const resourceIds = Array.isArray(body.resourceIds) ? body.resourceIds.map(String).filter(Boolean) : [];
    const contentHtml = String(body.contentHtml ?? "").trim();
    const title = String(body.title ?? record.plan.packs[0]?.titleSuggestion ?? "").trim();
    if (!resourceIds.length || !contentHtml || !title) {
      json(res, 400, { ok: false, message: "缺少 resourceIds / contentHtml / title" });
      return;
    }

    try {
      const orders = await submitOrder({ title, contentHtml, resourceIds });
      // 回填台账：新增发稿记录（order_id / 状态 / 媒体）
      const pubs = orders.map((o) => ({
        title,
        channel: `软文街#${o.resourceId}${o.resourceName ? "·" + o.resourceName : ""}`,
        supplier: "softwen",
        url: "", // 发布成功由回调回填
        collected: false,
        reads: 0,
        publishedAt: new Date().toISOString(),
        orderId: o.orderId,
      }));
      const cur = getPack(record.id);
      const next = updatePack(record.id, {
        status: "published",
        notes: (cur?.notes ? cur.notes + "\n" : "") + `[下单] ${new Date().toISOString().slice(0,16)} ${title} → ${orders.length} 家媒体（order_id: ${orders.map(o=>o.orderId).join(",")}）`,
        publications: [...(cur?.publications ?? []), ...pubs],
      });
      json(res, 200, { ok: true, orders, record: next });
    } catch (e) {
      json(res, 500, { ok: false, message: "下单失败：" + (e as Error).message });
    }
    return;
  }

  // POST /api/softwen/callback — 接收软文街订单结果推送（公网，软文街后台配置回调地址为此）
  if (req.method === "POST" && url.pathname === "/api/softwen/callback") {
    // 简单鉴权：若配了 SOFTWEN_CALLBACK_KEY，回调地址需带 ?key=xxx（软文街回调地址由我们提供，可带上）
    const cbKey = process.env.SOFTWEN_CALLBACK_KEY;
    if (cbKey) {
      const got = new URL(req.url!, "http://localhost").searchParams.get("key") ?? "";
      if (got !== cbKey) { json(res, 403, { ok: false, message: "callback key 不匹配" }); return; }
    }
    let payload: any;
    try { payload = JSON.parse(await readBody(req)); } catch { json(res, 200, { ok: false }); return; }
    const items: CallbackItem[] = parseCallback(payload);
    // 回填台账：按 order_id 关联发稿记录，更新 url / collected
    let updated = 0;
    let tracked = 0;
    for (const it of items) {
      const all = loadLedger();
      for (const rec of all) {
        const idx = rec.publications.findIndex((p) => p.orderId === it.orderId);
        if (idx < 0) continue;
        if (it.status === 200) {
          const pubs = rec.publications.slice();
          const pub = pubs[idx];
          const url = it.responseMessage || pub.url;
          const wasTracked = !!pub.tracked;
          let isTracked = wasTracked;
          pubs[idx] = { ...pub, url, collected: true, tracked: wasTracked || undefined };
          // 统一闭环：发布链接自动纳入引用追踪（articles.json 监测库）
          // topic 用需求单关键词，让 AI 按该主题提问时能引用到这篇稿子
          if (url && !wasTracked) {
            const arts = loadArticles();
            if (!arts.some((a) => a.url === url)) {
              const kw = rec.plan?.packs?.[0]?.keywords ?? [];
              arts.push({
                id: "sw-" + Date.now().toString(36),
                title: pub.title || rec.plan?.packs?.[0]?.titleSuggestion || url,
                url,
                topic: kw.join("、") || pub.title || url,
                createdAt: new Date().toISOString(),
              });
              saveArticles(arts);
              tracked++;
              isTracked = true;
              pubs[idx] = { ...pubs[idx], tracked: true };
            }
          }
          updatePack(rec.id, { publications: pubs });
          updated++;
        } else {
          updatePack(rec.id, {
            notes: (rec.notes ? rec.notes + "\n" : "") + `[失败] order_id=${it.orderId} ${it.responseMessage}`,
          });
          updated++;
        }
      }
    }
    json(res, 200, { ok: true, received: items.length, updated, tracked });
    return;
  }

  // POST /api/softwen/track — 手动把发稿链接纳入引用追踪并立即检测
  // body: { packId, orderId } → 从台账取该条发稿记录，加入 articles.json 并 checkArticles
  if (req.method === "POST" && url.pathname === "/api/softwen/track") {
    let body: { packId?: unknown; orderId?: unknown };
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { ok: false, message: "请求体不是合法 JSON" }); return; }
    const rec = getPack(String(body.packId ?? ""));
    const pub = rec?.publications?.find((p) => p.orderId === String(body.orderId ?? ""));
    if (!rec || !pub || !pub.url) {
      json(res, 400, { ok: false, message: "找不到该发稿记录，或发布链接尚未回填" });
      return;
    }
    try {
      // 1) 入监测库（若已有该 url 则复用）
      let art = loadArticles().find((a) => a.url === pub.url);
      if (!art) {
        const kw = rec.plan?.packs?.[0]?.keywords ?? [];
        art = {
          id: "sw-" + Date.now().toString(36),
          title: pub.title || rec.plan?.packs?.[0]?.titleSuggestion || pub.url,
          url: pub.url,
          topic: kw.join("、") || pub.title || pub.url,
          createdAt: new Date().toISOString(),
        };
        const arts = loadArticles();
        arts.push(art);
        saveArticles(arts);
      }
      // 2) 立即检测，并把结果存回监测库
      const [checked] = await checkArticles([art]);
      const artsAll = loadArticles();
      const ai = artsAll.findIndex((a) => a.url === pub.url);
      if (ai >= 0) artsAll[ai] = checked;
      else artsAll.push(checked);
      saveArticles(artsAll);
      // 3) 标记台账 tracked
      const pubs = rec.publications.slice();
      const i = pubs.findIndex((p) => p.orderId === pub.orderId);
      if (i >= 0) pubs[i] = { ...pubs[i], tracked: true };
      updatePack(rec.id, { publications: pubs });
      json(res, 200, { ok: true, tracked: true, check: checked.lastCheck ?? null, article: checked });
    } catch (e) {
      json(res, 500, { ok: false, message: "追踪失败：" + (e as Error).message });
    }
    return;
  }

  // GET /api/softwen/token — 检查软文街认证状态（token 缓存是否有效）
  if (req.method === "GET" && url.pathname === "/api/softwen/token") {
    try {
      await getToken();
      json(res, 200, { ok: true, authed: true });
    } catch {
      json(res, 200, { ok: true, authed: false });
    }
    return;
  }

  // ============ 发稿效果矩阵（行业 × 渠道 × AI 引用，Beta-Binomial 贝叶斯） ============

  // 效果矩阵页
  if (req.method === "GET" && url.pathname === "/effect") {
    res.writeHead(200, htmlHeaders);
    res.end(readFileSync(path.join(here, "src/web/effect.html"), "utf-8"));
    return;
  }

  // 全量矩阵（台账 × 文章监测 × 媒体目录 实时推导）
  if (req.method === "GET" && url.pathname === "/api/effect/matrix") {
    try {
      const matrix = buildEffectMatrix();
      json(res, 200, { ok: true, ...matrix });
    } catch (e) {
      json(res, 500, { ok: false, message: "构建效果矩阵失败：" + (e as Error).message });
    }
    return;
  }

  // 按行业推荐渠道（后验 5% 低值排序，保守；?industry=X&topN=12&minTrials=2）
  if (req.method === "GET" && url.pathname === "/api/effect/recommend") {
    const q = url.searchParams;
    const industry = String(q.get("industry") ?? "").trim();
    const topN = Math.min(20, Math.max(1, Number(q.get("topN") || 10)));
    const minTrials = Math.max(1, Number(q.get("minTrials") || 2));
    try {
      const recommendations = industry ? recommendForIndustry(industry, { topN, minTrials }) : [];
      json(res, 200, { ok: true, industry, recommendations, generatedAt: new Date().toISOString() });
    } catch (e) {
      json(res, 500, { ok: false, message: "推荐失败：" + (e as Error).message });
    }
    return;
  }

  // ============ 静态资产（observe / llms / robots / sitemap / 样式）——容器直接服务 Pages 时代的产物 ============
  if (req.method === "GET") {
    const p = url.pathname;
    if (p === "/observe" || p === "/observe/") {
      serveSiteFile(res, "observe/index.html", "text/html; charset=utf-8");
      return;
    }
    if (p === "/whitepaper" || p === "/whitepaper/") {
      serveSiteFile(res, "whitepaper.html", "text/html; charset=utf-8");
      return;
    }
    if (SITE_STATIC[p]) {
      if (serveSiteFile(res, p.replace(/^\//, ""), SITE_STATIC[p], true)) return;
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

/** 读取请求体（限制大小，防滥用） */
function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      data += chunk.toString("utf-8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** 站点静态资产映射（observe 页 / SEO 文件 / 样式） */
const siteDir = path.join(here, "site");
const SITE_STATIC: Record<string, string> = {
  "/llms.txt": "text/plain; charset=utf-8",
  "/robots.txt": "text/plain; charset=utf-8",
  "/sitemap.xml": "application/xml; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
  // IndexNow 域名验证 key（site/<key>.txt）
  "/5b53e066ee93a3da020b2e5666b46d42.txt": "text/plain; charset=utf-8",
};

/** 从 site/ 目录读静态文件；成功写响应返回 true，失败返回 false（调用方走 404） */
function serveSiteFile(res: import("node:http").ServerResponse, rel: string, type: string, cacheOk = false): boolean {
  try {
    const data = readFileSync(path.join(siteDir, rel));
    res.writeHead(200, {
      "Content-Type": type,
      ...(cacheOk ? { "Cache-Control": "public, max-age=600" } : { "Cache-Control": "no-cache" }),
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("\n========== GEOloopOS · AI 可见度增长闭环系统 ==========");
  console.log(`  本机访问:   http://localhost:${PORT}`);
  console.log(`  局域网访问: http://${lanIP()}:${PORT}`);
  console.log("  API：POST /api/check · GET /api/checks");
  console.log(`  限流：${PER_MIN}/分/IP · ${PER_DAY}/天/IP · 并发 ≤ ${MAX_CONCURRENT}`);
  console.log("===================================\n");
});

function lanIP(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}
