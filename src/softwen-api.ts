/**
 * 软文街 API 封装层 — 认证 / 媒体资源 / 提交订单 / 回调
 *
 * 对接真实接口（api.kol.cn，文档「软文街API接口文档2.0」）：
 *   1. POST /api/auth/authenticate      换 token（账号密码 + api_key + captcha 固定值）
 *   2. GET  /api/news_resource_2/data    拉媒体资源（分页，实测 93418 家 / 50 每页）
 *   3. POST /api/news_order              提交订单（title + HTML content + resource_ids）
 *   4. 回调                               平台 POST 结果到我们提供的地址
 *
 * 关键踩坑（2026-08-27 实测）：
 *   - captcha_token / captcha 固定填 "advertiser" 即可通过（文档示例值就是写死的）
 *   - token 有效期很长（JWT exp 约 41 天），缓存到 data/softwen-token.json，401 时自动重取
 *   - 平台对请求头有校验：undici/浏览器 fetch 默认的 accept-encoding 等头会触发
 *     401「未认证」。必须用最小请求头（User-Agent + Accept）走 https.request。
 *
 * 凭据从环境变量读（.env，已 gitignore）：
 *   SOFTWEN_MOBILE / SOFTWEN_PASSWORD / SOFTWEN_API_KEY
 */

import { request } from "node:https";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = "https://api.kol.cn";
const TOKEN_CACHE = path.resolve(process.cwd(), "data/softwen-token.json");

/* ---------- 底层 HTTP（最小请求头，平台防 fetch） ---------- */

function httpReq(method: string, pathname: string, params: Record<string, string>, body?: string): Promise<{ status: number; json: any }> {
  const qs = new URLSearchParams(params);
  const url = `${BASE}${pathname}${qs.size ? "?" + qs.toString() : ""}`;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method,
      headers: {
        "User-Agent": "curl/8.5.0",
        Accept: "*/*",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => {
        try {
          resolve({ status, json: JSON.parse(buf) });
        } catch {
          reject(new Error(`软文街响应非 JSON（HTTP ${status}）：${buf.slice(0, 120)}`));
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function jsonBody(obj: unknown): string {
  return JSON.stringify(obj);
}

/* ---------- 认证 ---------- */

function credentials() {
  const mobile = process.env.SOFTWEN_MOBILE;
  const password = process.env.SOFTWEN_PASSWORD;
  const apiKey = process.env.SOFTWEN_API_KEY ?? "3b98c40be00c15f9ec69131076646eb7";
  if (!mobile || !password) throw new Error("缺少软文街凭据：.env 里设 SOFTWEN_MOBILE / SOFTWEN_PASSWORD");
  return { mobile, password, apiKey };
}

function readCachedToken(): string | null {
  try {
    if (!existsSync(TOKEN_CACHE)) return null;
    const j = JSON.parse(readFileSync(TOKEN_CACHE, "utf-8"));
    if (!j.token) return null;
    // 粗略判过期：JWT payload.exp（秒）留 1 小时余量
    const payload = j.token.split(".")[1];
    if (payload) {
      const exp = JSON.parse(Buffer.from(payload, "base64url").toString()).exp;
      if (exp && exp * 1000 < Date.now() + 3600_000) return null;
    }
    return j.token;
  } catch {
    return null;
  }
}

function cacheToken(token: string): void {
  writeFileSync(TOKEN_CACHE, JSON.stringify({ token, fetchedAt: new Date().toISOString() }) + "\n", "utf-8");
}

/** 换 token（账号密码 + api_key，验证码固定 advertiser） */
export async function authenticate(): Promise<string> {
  const { mobile, password, apiKey } = credentials();
  const { status, json } = await httpReq("POST", "/api/auth/authenticate", {}, jsonBody({
    mobile, password,
    identity: "advertiser",
    captcha_token: "advertiser",
    captcha: "advertiser",
    api_key: apiKey,
  }));
  if (status !== 200 || !json.success) {
    throw new Error(`软文街认证失败：${json.message ?? `HTTP ${status}`}`);
  }
  const token = json.data?.token;
  if (!token) throw new Error("软文街认证成功但未返回 token");
  cacheToken(token);
  return token;
}

/** 拿有效 token：优先缓存，过期/无缓存则重新认证 */
export async function getToken(): Promise<string> {
  const cached = readCachedToken();
  if (cached) return cached;
  return authenticate();
}

/** 带 token 且 401 自动重试一次的通用 GET */
async function authedGet(pathname: string, params: Record<string, string>): Promise<any> {
  let token = await getToken();
  let { status, json } = await httpReq("GET", pathname, { ...params, token }, undefined);
  if (status === 401) {
    token = await authenticate();
    ({ status, json } = await httpReq("GET", pathname, { ...params, token }, undefined));
  }
  if (!json.success) throw new Error(`软文街 ${pathname} 失败：${json.message ?? `HTTP ${status}`}`);
  return json;
}

/* ---------- 媒体资源 ---------- */

/** 拉单页媒体资源（每页 50 条） */
export async function getResourcesPage(page: number): Promise<{ total: number; lastPage: number; data: any[] }> {
  const json = await authedGet("/api/news_resource_2/data", { page: String(page) });
  return {
    total: json.pagination?.total ?? 0,
    lastPage: json.pagination?.last_page ?? page,
    data: json.data ?? [],
  };
}

/** 全量拉取媒体资源 → data/softwen/resources.jsonl（每行一条 JSON），返回条数 */
export async function syncAllResources(): Promise<number> {
  const outDir = path.join(path.dirname(TOKEN_CACHE), "softwen");
  const file = path.join(outDir, "resources.jsonl");
  const fs = await import("node:fs");
  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(file, { force: true });

  const first = await getResourcesPage(1);
  const seen = new Set<number>();
  const totalPages = first.lastPage;

  for (let page = 1; page <= totalPages; page++) {
    const { data } = page === 1 ? first : await getResourcesPage(page);
    for (const m of data) {
      if (m?.id && !seen.has(m.id)) {
        seen.add(m.id);
        fs.appendFileSync(file, JSON.stringify(m) + "\n", "utf-8");
      }
    }
    if (page % 100 === 0 || page === totalPages) console.log(`  page ${page}/${totalPages} · ${seen.size} 条`);
  }
  return seen.size;
}

/* ---------- 提交订单 ---------- */

export interface SubmitOrderResult {
  orderId: string;
  resourceId: number | string;
  resourceName?: string;
}

/** 提交软文订单。title + HTML content + resource_ids（可逗号分隔多个）→ 每媒体一个 order_id */
export async function submitOrder(opts: { title: string; contentHtml: string; resourceIds: (number | string)[] }): Promise<SubmitOrderResult[]> {
  const token = await getToken();
  const body = jsonBody({
    token,
    title: opts.title,
    content: opts.contentHtml,
    resource_id: opts.resourceIds.join(","),
  });
  const { status, json } = await httpReq("POST", "/api/news_order", {}, body);
  if (status === 401) {
    const t2 = await authenticate();
    const retry = await httpReq("POST", "/api/news_order", {}, jsonBody({
      token: t2, title: opts.title, content: opts.contentHtml, resource_id: opts.resourceIds.join(","),
    }));
    if (!retry.json.success) throw new Error(`软文街下单失败：${retry.json.message ?? `HTTP ${retry.status}`}`);
    return (retry.json.response_data ?? []).map((r: any) => ({
      orderId: String(r.order_id), resourceId: r.resource_id, resourceName: r.resource_name,
    }));
  }
  if (!json.success) throw new Error(`软文街下单失败：${json.message ?? `HTTP ${status}`}`);
  return (json.response_data ?? []).map((r: any) => ({
    orderId: String(r.order_id), resourceId: r.resource_id, resourceName: r.resource_name,
  }));
}

/* ---------- 订单结果回调 ---------- */

export interface CallbackItem {
  orderId: string;
  /** 200=发布成功，400=失败 */
  status: number;
  /** 成功=发布地址；失败=失败原因 */
  responseMessage: string;
}

/** 解析平台推送的订单结果数组 {data: [{order_id, status, response_message}]} */
export function parseCallback(body: any): CallbackItem[] {
  const data = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return data
    .map((d: any) => ({
      orderId: String(d.order_id ?? ""),
      status: Number(d.status ?? 0),
      responseMessage: String(d.response_message ?? ""),
    }))
    .filter((d: CallbackItem) => d.orderId);
}
