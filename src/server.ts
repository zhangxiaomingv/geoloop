import "dotenv/config";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCheck } from "./check.js";
import { appendCheck, listChecks } from "./history.js";
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

  // 静态页
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(pageFile, "utf-8"));
    return;
  }

  // 品牌 logo（桌面 logo 文件夹定稿：SVG 矢量 + PNG 透明）
  if (req.method === "GET" && (url.pathname === "/logo.svg" || url.pathname === "/logo.png" || url.pathname === "/logo-final.png")) {
    const isSvg = url.pathname.endsWith(".svg");
    res.writeHead(200, { "Content-Type": isSvg ? "image/svg+xml" : "image/png", "Cache-Control": "public, max-age=3600" });
    res.end(readFileSync(path.join(here, isSvg ? "src/web/logo.svg" : "src/web/logo-final.png")));
    return;
  }

  // 检测历史
  if (req.method === "GET" && url.pathname === "/api/checks") {
    const limit = Math.min(Number(url.searchParams.get("limit") || 20), 50);
    json(res, 200, { ok: true, checks: listChecks(limit) });
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

server.listen(PORT, "0.0.0.0", () => {
  console.log("\n========== GEOloopOS · AI 可见度基础设施 ==========");
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
