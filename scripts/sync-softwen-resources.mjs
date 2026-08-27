#!/usr/bin/env node
/**
 * sync-softwen-resources.mjs — 拉取软文街全部媒体资源，本地缓存 + 生成占比统计
 *
 * 用法：
 *   SOFTWEN_TOKEN=xxx node scripts/sync-softwen-resources.mjs
 *   # 或从 data/softwen-token.json 读 token（softwen-api.ts 写出的缓存）
 *
 * 产物：
 *   data/softwen/resources.jsonl  — 全量媒体（每行一条）
 *   data/softwen/stats.json        — 占比统计（自媒体/门户/行业站/收录类型/权重分层）
 *
 * 建议每天同步 3 次（文档建议），配 cron：
 *   0 2,10,18 * * * SOFTWEN_TOKEN=xxx node ~/geoloopos/scripts/sync-softwen-resources.mjs
 */

import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { request } from "node:https";

const BASE = "https://api.kol.cn";
const PER_PAGE = 50;
const HERE = path.resolve(process.cwd());
const OUT_DIR = path.join(HERE, "data", "softwen");
const RES_FILE = path.join(OUT_DIR, "resources.jsonl");
const STATS_FILE = path.join(OUT_DIR, "stats.json");

/**
 * 软文街平台的坑：undici/浏览器 fetch 默认附带的请求头（accept-encoding 等）
 * 会触发 401「未认证」。必须用最小请求头（只带 User-Agent + Accept）走 https.request。
 */
function apiGet(pathname, params = {}) {
  const qs = new URLSearchParams(params);
  return new Promise((resolve, reject) => {
    const req = request(
      `${BASE}${pathname}${qs.size ? "?" + qs.toString() : ""}`,
      {
        method: "GET",
        headers: { "User-Agent": "curl/8.5.0", Accept: "*/*" },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body) });
          } catch (e) {
            reject(new Error(`响应非 JSON（HTTP ${res.statusCode}）：${body.slice(0, 120)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function getToken() {
  if (process.env.SOFTWEN_TOKEN) return process.env.SOFTWEN_TOKEN;
  const cache = path.join(HERE, "data", "softwen-token.json");
  if (existsSync(cache)) {
    try {
      const j = JSON.parse(readFileSync(cache, "utf-8"));
      if (j.token) return j.token;
    } catch {}
  }
  throw new Error("缺少 token：设 SOFTWEN_TOKEN 环境变量，或先跑认证写 data/softwen-token.json");
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const token = getToken();

  // 1. 首页拿分页信息
  const { json: j1 } = await apiGet("/api/news_resource_2/data", { page: 1, token });
  if (!j1.success) throw new Error("首页拉取失败: " + JSON.stringify(j1));
  const { total, last_page } = j1.pagination;
  console.log(`总资源：${total} 条，共 ${last_page} 页`);

  const seen = new Set();
  let count = 0;
  const writer = [];
  const flush = () => {
    const chunk = writer.splice(0);
    writeFileSync(RES_FILE, chunk.join(""), { flag: "a" });
  };

  // 2. 逐页拉取（串行，避免打爆接口）
  for (let page = 1; page <= last_page; page++) {
    let data = null;
    for (let attempt = 0; attempt < 3 && !data; attempt++) {
      try {
        const { status, json: j } = await apiGet("/api/news_resource_2/data", { page, token });
        if (status === 401) throw new Error("token 失效：重新认证后再试");
        if (!j.success) throw new Error(j.message || "接口失败");
        data = j.data;
      } catch (e) {
        if (attempt === 2) console.warn(`第 ${page} 页重试3次失败：${e.message}`);
        else await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
      }
    }
    if (!data) continue;

    for (const m of data) {
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      writer.push(JSON.stringify(m) + "\n");
    }
    count = seen.size;
    if (page % 50 === 0 || page === last_page) {
      flush();
      console.log(`  page ${page}/${last_page} · 已去重 ${count} 条`);
    }
  }
  flush();

  // 3. 统计
  const stats = computeStats(RES_FILE);
  writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2) + "\n", "utf-8");
  console.log("\n✅ 拉取完成，共 " + count + " 条");
  console.log("统计已写入 " + STATS_FILE);
}

function computeStats(resFile) {
  const isZimeiti = { "1": 0, "2": 0, other: 0 }; // 1自媒体 2软文媒体
  const sortType = {};
  const includeType = {};
  const mediaType = {};
  const recommendTag = {};
  const urlType = {};
  const pcWeightTier = { "权重0-3": 0, "权重4-6": 0, "权重7-10": 0, "无权重字段": 0 };
  const areaCount = {};
  const priceTier = { "≤30": 0, "31-60": 0, "61-100": 0, "101-200": 0, ">200": 0 };
  let total = 0;

  const lines = readFileSync(resFile, "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    total++;

    const zt = String(m.is_zimeiti ?? "");
    isZimeiti[zt === "1" ? "1" : zt === "2" ? "2" : "other"]++;

    sortType[m.sort_type ?? "未知"] = (sortType[m.sort_type ?? "未知"] ?? 0) + 1;
    includeType[m.include_type ?? "未知"] = (includeType[m.include_type ?? "未知"] ?? 0) + 1;
    mediaType[m.media ?? "未标"] = (mediaType[m.media ?? "未标"] ?? 0) + 1;
    urlType[m.url_type ?? "未知"] = (urlType[m.url_type ?? "未知"] ?? 0) + 1;
    areaCount[m.area ?? "未知"] = (areaCount[m.area ?? "未知"] ?? 0) + 1;

    if (Array.isArray(m.recommend)) for (const t of m.recommend) recommendTag[t] = (recommendTag[t] ?? 0) + 1;

    const pcw = m.pc_weight;
    const tier = pcw == null ? "无权重字段" : pcw <= 3 ? "权重0-3" : pcw <= 6 ? "权重4-6" : "权重7-10";
    pcWeightTier[tier]++;

    const price = m.price ?? m.price_market ?? 0;
    const pt = price <= 30 ? "≤30" : price <= 60 ? "31-60" : price <= 100 ? "61-100" : price <= 200 ? "101-200" : ">200";
    priceTier[pt]++;
  }

  const pct = (n) => (total ? ((n / total) * 100).toFixed(1) + "%" : "0%");
  const sortByCount = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);

  return {
    generatedAt: new Date().toISOString(),
    total,
    isZimeiti: { "自媒体": isZimeiti["1"], "软文媒体": isZimeiti["2"], other: isZimeiti.other, 自媒体占比: pct(isZimeiti["1"]), 软文媒体占比: pct(isZimeiti["2"]) },
    sortType: sortByCount(sortType),
    includeType: sortByCount(includeType),
    mediaType: sortByCount(mediaType),
    recommendTag: sortByCount(recommendTag).slice(0, 20),
    urlType: sortByCount(urlType),
    pcWeightTier: { ...pcWeightTier, 有权重字段占比: pct(total - pcWeightTier["无权重字段"]) },
    priceTier: sortByCount(priceTier),
    topAreas: sortByCount(areaCount).slice(0, 10),
  };
}

main().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
