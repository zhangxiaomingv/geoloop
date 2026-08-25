/**
 * AI 爬虫来访事件 · 本地存储（双信号架构 · 输入侧，替代 D1）
 *
 * 数据流：geoloopos.com 容器内联 UA 检测 + zkoner.com 等站点边缘中间件
 *        → 都汇聚到 data/observations/events.jsonl（append-only JSONL）
 *        → scripts/sync-observations.mjs 每小时重生成 site/observe/index.html
 *
 * 三道闸门与旧 D1 接收器一致（这是鉴权写入口）：
 *   ① Bearer token 鉴权：无/错 token → 401
 *   ② site 白名单 + bot_id 必须在 data/bots.json 注册表内 → 403/400
 *   ③ 每 site 每日写入上限 DAILY_CAP 条 → 429（防 token 泄漏后被灌爆）
 */
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface ObserveEvent {
  site: string;
  bot_id: string;
  url: string;
  ts: number;
}

const here = process.cwd();
const EVENTS_FILE = path.join(here, "data/observations/events.jsonl");
const BOTS_FILE = path.join(here, "data/bots.json");

const OBSERVE_TOKEN = (process.env.OBSERVE_TOKEN || "").trim();
const OBSERVE_SITES = new Set(
  (process.env.OBSERVE_SITES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const DAILY_CAP = 5000;
const MAX_BATCH = 100;
const MIN_TS = 1577836800000; // 2020-01-01

/** 爬虫身份表（唯一事实源 data/bots.json） */
let bots: Array<{ id: string; match?: unknown[] }> = [];
try {
  bots = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
} catch {
  bots = [];
}
const BOT_IDS = new Set(bots.map((b) => b.id));

/** 展平成 [id, 小写匹配子串] 表——单循环 UA 匹配（与 Pages 中间件同源逻辑） */
const flat: Array<[string, string]> = [];
for (const b of bots) {
  for (const m of b.match ?? []) flat.push([b.id, String(m).toLowerCase()]);
}

/** 站点是否在白名单内（用于内联检测，避免记录非自家域名流量） */
export function isObservedSite(host: string): boolean {
  return OBSERVE_SITES.has(host.toLowerCase().replace(/^www\./, "").split(":")[0]);
}

/** UA 命中返回 bot_id，否则 null */
export function detectBot(ua: string): string | null {
  const u = String(ua ?? "").toLowerCase();
  if (!u) return null;
  for (const [id, m] of flat) {
    if (u.includes(m)) return id;
  }
  return null;
}

/** 读全部事件（无文件则为空数组） */
export function loadEvents(): ObserveEvent[] {
  try {
    const raw = readFileSync(EVENTS_FILE, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as ObserveEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is ObserveEvent => Boolean(e));
  } catch {
    return [];
  }
}

/** 追加事件（批量；单条自动 JSON 化） */
export function appendEvents(events: ObserveEvent[] | ObserveEvent): void {
  const list = Array.isArray(events) ? events : [events];
  if (!list.length) return;
  mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
  appendFileSync(EVENTS_FILE, list.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** 单站今日写入量（UTC 日界）——每日上限检查用 */
function countToday(site: string): number {
  const dayStart = Math.floor(Date.now() / 86400000) * 86400000;
  return loadEvents().filter((e) => e.site === site && e.ts >= dayStart).length;
}

/** POST /api/observe 接收器。纯函数返回 {status, body}，由 server 回写。 */
export function receiveObserve(bodyText: string, authHeader: string): { status: number; body: unknown } {
  if (!OBSERVE_TOKEN) return { status: 500, body: { ok: false, message: "server not configured" } };
  if (authHeader !== `Bearer ${OBSERVE_TOKEN}`) {
    return { status: 401, body: { ok: false, message: "unauthorized" } };
  }

  let body: { events?: Array<Record<string, unknown>> };
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { ok: false, message: "invalid json" } };
  }
  const rawEvents = Array.isArray(body.events) ? body.events.slice(0, MAX_BATCH) : [];
  if (rawEvents.length === 0) return { status: 400, body: { ok: false, message: "events required" } };

  const now = Date.now();
  const clean: ObserveEvent[] = [];
  for (const e of rawEvents) {
    const site = typeof e.site === "string" ? e.site.toLowerCase().trim() : "";
    const botId = typeof e.bot_id === "string" ? e.bot_id.toLowerCase().trim() : "";
    if (!OBSERVE_SITES.has(site)) return { status: 403, body: { ok: false, message: `site not allowed: ${site}` } };
    if (!BOT_IDS.has(botId)) return { status: 400, body: { ok: false, message: `unknown bot_id: ${botId}` } };
    let url = typeof e.url === "string" ? e.url : "/";
    if (!url.startsWith("/")) url = "/" + url;
    url = url.slice(0, 512);
    const ts = typeof e.ts === "number" && e.ts > MIN_TS && e.ts < now + 86400000 ? Math.floor(e.ts) : now;
    clean.push({ site, bot_id: botId, url, ts });
  }

  /* 单站每日上限（UTC 日界） */
  const sitesInBatch = [...new Set(clean.map((e) => e.site))];
  for (const s of sitesInBatch) {
    if (countToday(s) + clean.filter((e) => e.site === s).length > DAILY_CAP) {
      return { status: 429, body: { ok: false, message: `daily cap exceeded for ${s}` } };
    }
  }

  appendEvents(clean);
  return { status: 200, body: { ok: true, accepted: clean.length } };
}
