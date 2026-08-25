/**
 * POST /api/observe —— AI 爬虫来访事件接收器（双信号架构 · 输入侧入库口）
 *
 * 数据流：客户站边缘中间件（如 zkoner.com 的 _middleware）识别到 AI 爬虫 UA
 *        → 批量 POST 到这里 → 校验后写入 D1（crawl_events 表）。
 *
 * 三道闸门（与 /api/check 的 IP 限流不同——这里是鉴权写入口）：
 *   ① Bearer token 鉴权：无/错 token → 401
 *   ② site 白名单 + bot_id 必须在 data/bots.json 注册表内 → 403/400
 *   ③ 每 site 每日写入上限 DAILY_CAP 条 → 429（防 token 泄漏后被灌爆）
 *
 * 只收白名单字段 {site, bot_id, url, ts}，多余字段一律丢弃。
 */
import botsData from "../../data/bots.json";

const DAILY_CAP = 5000;
const MAX_BATCH = 100;

/** 已注册爬虫 id 集合（唯一事实源 data/bots.json） */
const BOT_IDS = new Set((botsData as Array<{ id: string }>).map((b) => b.id));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

interface RawEvent {
  site?: unknown;
  bot_id?: unknown;
  url?: unknown;
  ts?: unknown;
}

export const onRequestGet = async (): Promise<Response> =>
  json(200, { ok: true, service: "observe", hint: "POST events with Bearer token" });

export const onRequestPost = async ({
  request,
  env,
}: {
  request: Request;
  env: Record<string, any>;
}): Promise<Response> => {
  /* ① 鉴权 */
  const token = (env.OBSERVE_TOKEN || "").trim();
  if (!token) return json(500, { ok: false, message: "server not configured" });
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${token}`) {
    return json(401, { ok: false, message: "unauthorized" });
  }

  /* ② 解析与校验 */
  let body: { events?: RawEvent[] };
  try {
    body = await request.json();
  } catch {
    return json(400, { ok: false, message: "invalid json" });
  }
  const rawEvents = Array.isArray(body.events) ? body.events.slice(0, MAX_BATCH) : [];
  if (rawEvents.length === 0) return json(400, { ok: false, message: "events required" });

  const sites = String(env.OBSERVE_SITES || "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
  const siteSet = new Set(sites);

  const now = Date.now();
  const MIN_TS = 1577836800000; // 2020-01-01
  const clean: { site: string; bot_id: string; url: string; ts: number }[] = [];
  for (const e of rawEvents) {
    const site = typeof e.site === "string" ? e.site.toLowerCase().trim() : "";
    const botId = typeof e.bot_id === "string" ? e.bot_id.toLowerCase().trim() : "";
    if (!siteSet.has(site)) return json(403, { ok: false, message: `site not allowed: ${site}` });
    if (!BOT_IDS.has(botId)) return json(400, { ok: false, message: `unknown bot_id: ${botId}` });
    let url = typeof e.url === "string" ? e.url : "/";
    if (!url.startsWith("/")) url = "/" + url;
    url = url.slice(0, 512);
    const ts = typeof e.ts === "number" && e.ts > MIN_TS && e.ts < now + 86400000 ? Math.floor(e.ts) : now;
    clean.push({ site, bot_id: botId, url, ts });
  }

  /* ③ 单站每日上限（UTC 日界） */
  const dayStart = Math.floor(now / 86400000) * 86400000;
  const sitesInBatch = [...new Set(clean.map((e) => e.site))];
  for (const s of sitesInBatch) {
    try {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM crawl_events WHERE site = ? AND ts >= ?"
      )
        .bind(s, dayStart)
        .first<{ c: number }>();
      if ((row?.c ?? 0) + clean.filter((e) => e.site === s).length > DAILY_CAP) {
        return json(429, { ok: false, message: `daily cap exceeded for ${s}` });
      }
    } catch {
      return json(500, { ok: false, message: "storage error" });
    }
  }

  /* 入库（批量） */
  const stmts = clean.map((e) =>
    env.DB.prepare("INSERT INTO crawl_events (site, bot_id, url, ts) VALUES (?, ?, ?, ?)").bind(
      e.site,
      e.bot_id,
      e.url,
      e.ts
    )
  );
  try {
    await env.DB.batch(stmts);
  } catch {
    return json(500, { ok: false, message: "insert failed" });
  }

  return json(200, { ok: true, accepted: clean.length });
};
