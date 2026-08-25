/**
 * geoloopos.com 公网检测 API（Cloudflare Pages Function）
 * 与引擎 src/check.ts 同构：输入品牌/网站/问句 → 分类 → 并行询问 AI 源 → 三维打分 → 报告。
 * 纯 API 源（DeepSeek + 豆包 + Ox Alpha，OpenAI 兼容），key 只存在 Pages secret，不进前端。
 * 部署：`npx wrangler pages deploy site --project-name geoloopos-com`
 * 限流：per-isolate 内存；若绑定 KV 命名空间 GEO_RATE 则升级为跨节点限流。
 */

const PER_MIN = 6;
const PER_DAY = 60;
const MAX_CONCURRENT = 3;
const TIMEOUT_MS = 22000; // 单次 AI 调用超时；双问句并行，整体 < 30s 边缘墙钟限制

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DOUBAO_URL = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const SOURCE_PROMPT =
  "（回答时如涉及信息来源，请给出真实来源链接或平台名称；不确定来源时请勿编造链接）";

interface CheckResult {
  provider: string;
  providerLabel: string;
  question: string;
  answer: string;
  mention: boolean;
  description: 0 | 15 | 30;
  source: boolean;
  cites: string[];
  error?: string;
  score: number;
}

interface Report {
  id: string;
  createdAt: string;
  query: string;
  type: "brand" | "site" | "question";
  entity: string;
  entityLabel: string;
  questions: string[];
  results: CheckResult[];
  score: number;
  verdict: string;
  tips: string[];
  citationMap: unknown;
}

/* ---------- 输入分类 ---------- */

const DOMAIN_RE =
  /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,})(?:[\/\s,，。;]|$)/;
const QUESTION_RE =
  /[?？]|\b(什么|怎么|如何|为什么|哪家|哪些|是否|吗|呢|多少|谁|何时|哪里)\s*[?？]?$/;

function classify(query: string) {
  const q = query.trim();
  const domain = q.match(DOMAIN_RE)?.[1];
  if (domain) {
    const d = domain.toLowerCase();
    return {
      type: "site" as const,
      entity: d,
      entityLabel: d,
      questions: [`「${d}」是什么网站？`, `「${d}」网站的主要内容和作用是什么？`],
    };
  }
  if (QUESTION_RE.test(q)) {
    return {
      type: "question" as const,
      entity: q,
      entityLabel: q.length > 22 ? q.slice(0, 22) + "…" : q,
      questions: [q],
    };
  }
  return {
    type: "brand" as const,
    entity: q,
    entityLabel: q.length > 22 ? q.slice(0, 22) + "…" : q,
    questions: [`「${q}」是什么？`, `「${q}」提供哪些产品或服务？`],
  };
}

/* ---------- 评分 ---------- */

const REFUSAL_RE =
  /抱歉|对不起|无法回答|不能回答|无法提供|未能提供|没有找到|没有搜索到|没有.{0,8}(信息|资料)|不予置评|不太清楚|暂未|暂无|我没有|我.{0,8}(无法|不能|不知道)|不能为你|无法为你/;

function sourceForSite(text: string, domain: string): boolean {
  return (
    (/(https?:\/\/|www\.)/.test(text) && text.includes(domain)) ||
    (text.includes(domain) && /官网|官方(网站|网址|站点)/.test(text))
  );
}

const ANY_SOURCE_RE =
  /https?:\/\/|www\.|[a-zA-Z0-9-]+\.(com|cn|net|org|io|co|me|ai|dev|gov|edu)(\/|\s|$|[，。;])/;

function scoreAnswer(entity: string, answer: string, type: string) {
  const text = answer.trim();
  const mention = type === "question" ? false : text.includes(entity);
  const len = text.replace(/\s+/g, "").length;
  const isRefusal = len < 80 && REFUSAL_RE.test(text);
  if (!text || isRefusal) return { mention, description: 0, source: false, score: 0 };
  const description: 0 | 15 | 30 = len >= 80 ? 30 : len >= 30 ? 15 : 0;
  const source = type === "site" ? sourceForSite(text, entity) : ANY_SOURCE_RE.test(text);
  const score = Math.round((mention ? 40 : 0) + description + (source ? 30 : 0));
  return { mention, description, source, score };
}

/* ---------- AI Citation Map 引用地图 ---------- */

function extractCitedDomains(text: string): string[] {
  return (
    (text.toLowerCase().match(/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/g) || [])
      .map((d) => d.replace(/^www\./, ""))
      .filter((d) => d.includes("."))
      .filter((d) => !/^\d+\.[a-z]/.test(d))
  );
}

const MEDIA_RE =
  /(?:sina|weibo|163\.com|netease|sohu|ifeng|thepaper|36kr|huxiu|jiemian|yicai|caixin|xinhuanet|people\.com|chinanews|cctv|eastmoney|cls\.cn|qq\.com|bbc|cnn|reuters|bloomberg|nytimes|guardian)/;
const SUSPECT_DOMAIN_RE = /(?:^|\.)(xxx|example|test|placeholder|domain|sample)(?:\.|$)/i;
const TRUST_RANK: Record<string, number> = { engine: 3, mentioned: 2, suspected: 1 };

function classifyCitationDomain(d: string, entityDomain?: string): string {
  if (entityDomain && (d === entityDomain || d.endsWith("." + entityDomain))) return "官网";
  if (d === "zhihu.com" || d.endsWith(".zhihu.com")) return "知乎";
  if (d === "baidu.com" || d.endsWith(".baidu.com")) return "百度";
  if (d === "xiaohongshu.com" || d.endsWith(".xiaohongshu.com") || d === "xhslink.com")
    return "小红书";
  if (MEDIA_RE.test(d)) return "媒体";
  return "其他";
}

function buildCitationMap(results: CheckResult[], entityDomain?: string) {
  const domMap = new Map<string, { count: number; trust: string; urls: string[] }>();
  const catCounts = new Map<string, number>();
  const trustSummary = { engine: 0, mentioned: 0, suspected: 0 };
  let total = 0;

  function addDomain(domain: string, trust: string) {
    const cur = domMap.get(domain);
    if (cur) {
      cur.count++;
      if (TRUST_RANK[trust] > TRUST_RANK[cur.trust]) cur.trust = trust;
    } else {
      domMap.set(domain, { count: 1, trust, urls: [] });
    }
    trustSummary[trust as keyof typeof trustSummary]++;
    total++;
    const cat = classifyCitationDomain(domain, entityDomain);
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
  }

  for (const r of results) {
    if (r.error) continue;
    for (const d of extractCitedDomains(r.answer)) {
      addDomain(d, SUSPECT_DOMAIN_RE.test(d) ? "suspected" : "mentioned");
    }
  }

  if (!total) {
    return {
      total: 0,
      categories: [],
      top: [],
      hasOwnSite: false,
      headline: "本次检测的回答没有引用任何外部来源——这是你最大的机会：让 AI 引用你。",
      citations: [],
      share: [],
      trustSummary,
    };
  }

  const categories = [...catCounts.entries()]
    .map(([category, count]) => ({ category, count, pct: Math.round((count / total) * 100) }))
    .sort((a, b) => b.count - a.count);

  const top = [...domMap.entries()]
    .map(([domain, v]) => ({
      domain,
      category: classifyCitationDomain(domain, entityDomain),
      count: v.count,
      pct: Math.round((v.count / total) * 100),
      trust: v.trust,
    }))
    .sort((a, b) => b.count - a.count || TRUST_RANK[b.trust] - TRUST_RANK[a.trust])
    .slice(0, 8);

  const lead = categories[0];
  const ownCount = catCounts.get("官网") ?? 0;
  const hasOwnSite = ownCount > 0;
  const ownPct = Math.round((ownCount / total) * 100);

  let headline: string;
  if (hasOwnSite) {
    headline = `你的官网已被 AI 提及 ${ownCount}/${total}（${ownPct}%）。继续扩大官网可检索内容，把「主要信息源」地位坐实。`;
  } else if (entityDomain) {
    headline = `你的网站明明写了，但 AI 根本没把你当成主要信息源——它优先相信「${lead?.category ?? "其他"}」等来源（${lead?.pct ?? 0}%）。`;
  } else {
    headline = `溯源：AI 回答提到了 ${total} 个来源域名，「${lead?.category ?? "其他"}」类占 ${lead?.pct ?? 0}%。要让 AI 引用你，先让官网与内容可被检索。`;
  }

  return {
    total,
    categories,
    top,
    hasOwnSite,
    headline,
    citations: [],
    share: [],
    trustSummary,
  };
}

/* ---------- 结论与建议 ---------- */

function verdictFor(score: number, type: string): string {
  if (type === "question") {
    return score >= 60 ? "AI 回答质量较高" : score >= 40 ? "AI 回答一般" : "AI 回答质量较低";
  }
  if (score >= 80) return "AI 认知清晰";
  if (score >= 60) return "AI 有基础认知";
  if (score >= 40) return "AI 认知模糊";
  return "AI 尚未认知";
}

function tipsFor(
  _type: string,
  mentionFailed: boolean,
  depthFailed: boolean,
  sourceFailed: boolean,
  score: number
): string[] {
  const tips: string[] = [];
  if (score >= 80) {
    tips.push("保持内容更新与多平台联动，AI 认知会持续巩固。");
    return tips;
  }
  if (mentionFailed) {
    tips.push(
      "AI 未提及你：建立可被检索的公开信息源（官网、知乎、GitHub、公众号），各平台统一「品牌名 + 一句话定位」口径。"
    );
  }
  if (depthFailed) {
    tips.push(
      "AI 描述不足：在官网提供清晰的价值主张、产品/服务说明与 FAQ，并加上结构化数据（Schema.org）。"
    );
  }
  if (sourceFailed) {
    tips.push(
      "AI 未引用来源：让官网可被 AI 爬取（sitemap、robots 放行 AI 爬虫、开放公开内容），并在平台简介统一挂官网链接。"
    );
  }
  if (!tips.length) {
    tips.push("定期检测观察趋势；在知乎/GitHub 等 AI 语料高权重平台持续产出同口径内容。");
  }
  return tips.slice(0, 4);
}

/* ---------- AI 源查询（OpenAI 兼容） ---------- */

async function queryApi(
  url: string,
  model: string,
  key: string,
  text: string
): Promise<{ raw: string; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: text }],
        temperature: 0.2,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { raw: "", error: `API ${res.status}` };
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return { raw: data.choices?.[0]?.message?.content?.trim() ?? "" };
  } catch {
    return { raw: "", error: "AI 源暂时不可用，请稍后再试" };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 执行一次检测 ---------- */

async function runCheck(query: string, env: Record<string, string | undefined>): Promise<Report> {
  const { type, entity, entityLabel, questions } = classify(query);

  const providers: { id: string; label: string; url: string; model: string; key?: string }[] = [];
  if (env.DEEPSEEK_API_KEY) {
    providers.push({ id: "deepseek", label: "DeepSeek", url: DEEPSEEK_URL, model: "deepseek-chat", key: env.DEEPSEEK_API_KEY });
  }
  if (env.ARK_API_KEY) {
    providers.push({
      id: "doubao",
      label: "豆包",
      url: DOUBAO_URL,
      model: env.DOUBAO_MODEL || "doubao-seed-2-0-pro-260215",
      key: env.ARK_API_KEY,
    });
  }
  if (env.OPENROUTER_API_KEY) {
    providers.push({
      id: "openrouter",
      label: "Ox Alpha",
      url: OPENROUTER_URL,
      model: env.OPENROUTER_MODEL || "stealth/ox-alpha",
      key: env.OPENROUTER_API_KEY,
    });
  }

  const tasks = providers.flatMap((p) =>
    questions.map(async (q): Promise<CheckResult> => {
      if (!p.key) {
        return { provider: p.id, providerLabel: p.label, question: q, answer: "", mention: false, description: 0, source: false, cites: [], error: `缺少 ${p.label} key`, score: 0 };
      }
      const r = await queryApi(p.url, p.model, p.key, q + SOURCE_PROMPT);
      if (r.error) {
        return { provider: p.id, providerLabel: p.label, question: q, answer: "", mention: false, description: 0, source: false, cites: [], error: r.error, score: 0 };
      }
      const s = scoreAnswer(entity, r.raw, type);
      return {
        provider: p.id,
        providerLabel: p.label,
        question: q,
        answer: r.raw,
        mention: s.mention,
        description: s.description,
        source: s.source,
        cites: extractCitedDomains(r.raw),
        score: s.score,
      };
    })
  );
  const results = await Promise.all(tasks);

  const valid = results.filter((r) => !r.error);
  const score = valid.length ? Math.round(valid.reduce((s, r) => s + r.score, 0) / valid.length) : 0;
  const mentionFailed = valid.every((r) => !r.mention);
  const depthFailed = valid.every((r) => r.description === 0);
  const sourceFailed = valid.every((r) => !r.source);

  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    createdAt: new Date().toISOString(),
    query: query.trim(),
    type,
    entity,
    entityLabel,
    questions,
    results,
    score,
    verdict: verdictFor(score, type),
    tips: tipsFor(type, mentionFailed, depthFailed, sourceFailed, score),
    citationMap: buildCitationMap(results, type === "site" ? entity : undefined),
  };
}

/* ---------- 限流：KV 优先，回退 isolate 内存 ---------- */

const memHits = new Map<string, number[]>();
let running = 0;

async function allow(
  ip: string,
  kv?: { get: (k: string, t: "json") => Promise<unknown>; put: (k: string, v: string, o: { expirationTtl: number }) => Promise<unknown> }
): Promise<{ ok: boolean; retryAfterSec?: number }> {
  const now = Date.now();
  let arr: number[];
  if (kv) {
    const stored = (await kv.get(`rl:${ip}`, "json")) as number[] | null;
    arr = (stored || []).filter((t) => now - t < 86400000);
  } else {
    arr = (memHits.get(ip) || []).filter((t) => now - t < 86400000);
  }
  for (const [windowMs, max] of [
    [60000, PER_MIN],
    [86400000, PER_DAY],
  ] as [number, number][]) {
    const recent = arr.filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      const wait = Math.ceil((recent[0] + windowMs - now) / 1000);
      return { ok: false, retryAfterSec: Math.max(wait, 1) };
    }
  }
  arr.push(now);
  if (kv) await kv.put(`rl:${ip}`, JSON.stringify(arr), { expirationTtl: 172800 });
  else memHits.set(ip, arr);
  return { ok: true };
}

/* ---------- 处理 POST /api/check ---------- */

export const onRequestPost = async ({
  request,
  env,
}: {
  request: Request;
  env: Record<string, any>;
}): Promise<Response> => {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const lim = await allow(ip, env.GEO_RATE);
  if (!lim.ok) {
    return json(429, { ok: false, message: `请求太频繁，请 ${lim.retryAfterSec} 秒后再试`, retryAfterSec: lim.retryAfterSec });
  }
  if (running >= MAX_CONCURRENT) {
    return json(429, { ok: false, message: "当前检测人数较多，请稍后再试" });
  }

  let body: { query?: unknown };
  try {
    body = (await request.json()) as { query?: unknown };
  } catch {
    return json(400, { ok: false, message: "请求体不是合法 JSON" });
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return json(400, { ok: false, message: "请输入品牌名、网站或问题" });
  if (query.length > 200) return json(400, { ok: false, message: "输入过长（最多 200 字）" });

  running++;
  try {
    const report = await runCheck(query, env);
    return json(200, { ok: true, report });
  } catch {
    return json(500, { ok: false, message: "检测服务暂时不可用，请稍后再试" });
  } finally {
    running--;
  }
};

function json(code: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: code,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
