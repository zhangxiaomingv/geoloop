/**
 * 通用 AI 可见度检测引擎（产品端）
 * 输入品牌名 / 网站 / 问句 → 自动分类 → 动态生成问题集 → 并行询问 API 源
 * → 动态评分（认知 / 描述 / 来源）→ 报告 + 结论 + 优化建议。
 *
 * 与固定问题集监测不同：这里的问题、判定目标、评分全部按任意输入即时生成，
 * 任何人无需配置即可检测自己的品牌。
 */

import { providers } from "../config.js";
import { queryText } from "./providers.js";

export type InputType = "brand" | "site" | "question";

/** 单个「源 × 问题」的判定结果 */
export interface CheckResult {
  provider: string;
  providerLabel: string;
  question: string;
  answer: string;
  /** 认知：回答是否提及实体 */
  mention: boolean;
  /** 描述深度：0 无 / 15 简略 / 30 较完整 */
  description: 0 | 15 | 30;
  /** 来源：是否引用了可追溯来源（引擎真引用 或 站点模式=引用了该域名） */
  source: boolean;
  /** AI Citation Map：回答里出现的全部引用域名（文本抽取） */
  cites: string[];
  /** 溯源：引擎级真引用 URL（Perplexity 等带 citations 元数据的源）；纯文本源无 */
  citations?: string[];
  error?: string;
  score: number;
}

/** 一次检测的完整报告 */
export interface CheckReport {
  id: string;
  createdAt: string;
  query: string;
  type: InputType;
  /** 判定实体：品牌名 / 域名 / 问句自身 */
  entity: string;
  entityLabel: string;
  questions: string[];
  results: CheckResult[];
  /** 0-100，全部有效结果的均分 */
  score: number;
  verdict: string;
  tips: string[];
  /** AI Citation Map：回答引用来源聚合（占比 + 话术） */
  citationMap: CitationMap;
}

/* ---------- 输入分类 ---------- */

const DOMAIN_RE = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,})(?:[\/\s,，。;]|$)/;
const QUESTION_RE = /[?？]|\b(什么|怎么|如何|为什么|哪家|哪些|是否|吗|呢|多少|谁|何时|哪里)\s*[?？]?$/;

export function classify(query: string): { type: InputType; entity: string; entityLabel: string; questions: string[] } {
  const q = query.trim();

  // 含域名 → 网站模式
  const domain = q.match(DOMAIN_RE)?.[1];
  if (domain) {
    const d = domain.toLowerCase();
    return {
      type: "site",
      entity: d,
      entityLabel: d,
      questions: [`「${d}」是什么网站？`, `「${d}」网站的主要内容和作用是什么？`],
    };
  }

  // 是问句 → 问句模式（直接问，不做实体判定）
  if (QUESTION_RE.test(q)) {
    return { type: "question", entity: q, entityLabel: q.length > 22 ? q.slice(0, 22) + "…" : q, questions: [q] };
  }

  // 其余 → 品牌模式
  return {
    type: "brand",
    entity: q,
    entityLabel: q.length > 22 ? q.slice(0, 22) + "…" : q,
    questions: [`「${q}」是什么？`, `「${q}」提供哪些产品或服务？`],
  };
}

/* ---------- 评分 ---------- */

/**
 * 拒绝/无信息特征 —— 命中说明 AI 没有给出实质回答。
 * 注意：不能匹配裸「无法/不能/不知道」，它们会误伤正常长回答
 * （实测 GEO 科普回答里出现「无法覆盖极地地区」）。真实拒答几乎都是短句，
 * 所以触发条件 = 短回答(<80字) 且 命中以下具体拒答措辞。
 */
const REFUSAL_RE =
  /抱歉|对不起|无法回答|不能回答|无法提供|未能提供|没有找到|没有搜索到|没有.{0,8}(信息|资料)|不予置评|不太清楚|暂未|暂无|我没有|我.{0,8}(无法|不能|不知道)|不能为你|无法为你/;

/** 站点模式：答案是否「引用了该域名」——出现 http(s) 且含域名，或「域名 + 官网」连用 */
function sourceForSite(text: string, domain: string): boolean {
  return (/(https?:\/\/|www\.)/.test(text) && text.includes(domain)) || (text.includes(domain) && /官网|官方(网站|网址|站点)/.test(text));
}

/** 品牌/问句模式：答案是否出现任何可追溯来源（URL 或常见顶级域） */
const ANY_SOURCE_RE = /https?:\/\/|www\.|[a-zA-Z0-9-]+\.(com|cn|net|org|io|co|me|ai|dev|gov|edu)(\/|\s|$|[，。;])/;

export function scoreAnswer(entity: string, answer: string, type: InputType, citations?: string[]): { mention: boolean; description: 0 | 15 | 30; source: boolean; score: number } {
  const text = answer.trim();

  // 问句模式没有固定实体，认知维度不计（把权重让给描述与来源）
  const mention = type === "question" ? false : text.includes(entity);

  // 有效字符数（去空白）
  const len = text.replace(/\s+/g, "").length;

  // 只有短回答才可能是拒答；长回答即使出现个别否定词也是正常内容
  const isRefusal = len < 80 && REFUSAL_RE.test(text);

  if (!text || isRefusal) {
    return { mention, description: 0, source: false, score: 0 };
  }

  // 描述深度：按有效字符数启发式
  const description: 0 | 15 | 30 = len >= 80 ? 30 : len >= 30 ? 15 : 0;

  // 来源：引擎真引用（Perplexity citations）直接算「有可追溯来源」；否则回退文本判定
  const source = citations && citations.length > 0 ? true : type === "site" ? sourceForSite(text, entity) : ANY_SOURCE_RE.test(text);

  const score = Math.round((mention ? 40 : 0) + description + (source ? 30 : 0));
  return { mention, description, source, score };
}

/** 问句模式下，从所有回答里抽取出被提到的品牌/网站，做轻量高亮 */
export function extractMentions(results: CheckResult[]): string[] {
  const found = new Set<string>();
  for (const r of results) {
    if (!r.answer) continue;
    const doms = r.answer.match(/(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,})/g) || [];
    doms.forEach((d) => found.add(d.replace(/^https?:\/\/(www\.)?/i, "")));
  }
  return [...found].slice(0, 8);
}

/* ---------- AI Citation Map 引用地图（溯源） ---------- */

export type CitationCategory = "知乎" | "百度" | "小红书" | "官网" | "媒体" | "其他";

/** 引用可信度：engine=引擎真引用（Perplexity citations） / mentioned=回答提及（文本抽取，可能编造） / suspected=疑似编造 */
export type CitationTrust = "engine" | "mentioned" | "suspected";

export interface CitationMapCategory {
  category: CitationCategory;
  count: number;
  /** 占总引用百分比（四舍五入） */
  pct: number;
}

export interface CitationMapItem {
  domain: string;
  category: CitationCategory;
  count: number;
  pct: number;
  /** 引用可信度（同域多来源时取最高优先级 engine > mentioned > suspected） */
  trust: CitationTrust;
  /** 引擎真引用的可点击 URL（trust=engine 时） */
  urls?: string[];
}

/** 引擎级真引用原始记录（溯源明细） */
export interface CitationRecord {
  url: string;
  domain: string;
  category: CitationCategory;
  provider: string;
  providerLabel: string;
}

export interface CitationMap {
  /** 回答里被引域名出现总次数（mentioned + engine） */
  total: number;
  /** 分类聚合（降序） */
  categories: CitationMapCategory[];
  /** 具体域名 Top（降序，带可信度） */
  top: CitationMapItem[];
  /** 官网是否被引用 */
  hasOwnSite: boolean;
  /** 一句话话术 */
  headline: string;
  /** 溯源：引擎级真引用明细（Perplexity citations），可点击 */
  citations: CitationRecord[];
  /** 引用份额（Profound 口径）：仅引擎真引用域名，count/total 归一 */
  share: CitationMapItem[];
  /** 可信度分布：真引用 / 提及 / 疑似编造 计数 */
  trustSummary: { engine: number; mentioned: number; suspected: number };
}

/** 媒体域名关键词（启发式，可扩展） */
const MEDIA_RE =
  /(?:sina|weibo|163\.com|netease|sohu|ifeng|thepaper|36kr|huxiu|jiemian|yicai|caixin|xinhuanet|people\.com|chinanews|cctv|eastmoney|cls\.cn|qq\.com|bbc|cnn|reuters|bloomberg|nytimes|guardian)/;

/** 疑似编造/占位域名特征（AI 幻觉引用常见：xxx、example、test、placeholder、纯随机长域） */
const SUSPECT_DOMAIN_RE = /(?:^|\.)(xxx|example|test|placeholder|domain|sample)(?:\.|$)/i;

/** 从回答文本抽取所有引用域名（子域/多级域都可识别，忽略 www；纯数字主体如 06862.hk 是股票代码/代号，非引用来源） */
export function extractCitedDomains(text: string): string[] {
  return (
    (text.toLowerCase().match(/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/g) || [])
      .map((d) => d.replace(/^www\./, ""))
      .filter((d) => d.includes("."))
      .filter((d) => !/^\d+\.[a-z]/.test(d))
  );
}

/** 完整 URL → 根域名（忽略 www，去 query/hash） */
export function extractUrlDomain(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    const m = url.toLowerCase().match(/^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/);
    return m ? m[1] : null;
  }
}

/** 域名 → 引用来源分类。entityDomain 用于把「自己的官网」识别出来（站点检测模式） */
export function classifyCitationDomain(d: string, entityDomain?: string): CitationCategory {
  if (entityDomain && (d === entityDomain || d.endsWith("." + entityDomain))) return "官网";
  if (d === "zhihu.com" || d.endsWith(".zhihu.com")) return "知乎";
  if (d === "baidu.com" || d.endsWith(".baidu.com")) return "百度";
  if (d === "xiaohongshu.com" || d.endsWith(".xiaohongshu.com") || d === "xhslink.com") return "小红书";
  if (MEDIA_RE.test(d)) return "媒体";
  return "其他";
}

/** 域名 → 可信度：engine 真引用传 true；文本提及看是否疑似编造 */
function trustFor(domain: string, fromEngine: boolean): CitationTrust {
  if (fromEngine) return "engine";
  return SUSPECT_DOMAIN_RE.test(domain) ? "suspected" : "mentioned";
}

const TRUST_RANK: Record<CitationTrust, number> = { engine: 3, mentioned: 2, suspected: 1 };

/** 聚合一次检测的引用地图（溯源：真引用 + 提及 + 份额） */
export function buildCitationMap(results: CheckResult[], entityDomain?: string): CitationMap {
  const domMap = new Map<string, { count: number; trust: CitationTrust; urls: string[] }>();
  const catCounts = new Map<CitationCategory, number>();
  const citations: CitationRecord[] = [];
  const trustSummary = { engine: 0, mentioned: 0, suspected: 0 };
  let total = 0;

  /** 域名 key 的计数入口：同域多来源合并，trust 取最高优先级，urls 收集真引用 */
  function addDomain(domain: string, trust: CitationTrust, url?: string, provider?: string, providerLabel?: string) {
    const cur = domMap.get(domain);
    if (cur) {
      cur.count++;
      if (TRUST_RANK[trust] > TRUST_RANK[cur.trust]) cur.trust = trust;
      if (url) cur.urls.push(url);
    } else {
      domMap.set(domain, { count: 1, trust, urls: url ? [url] : [] });
    }
    trustSummary[trust]++;
    total++;
    const cat = classifyCitationDomain(domain, entityDomain);
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
    if (url) citations.push({ url, domain, category: cat, provider: provider ?? "", providerLabel: providerLabel ?? "" });
  }

  for (const r of results) {
    if (r.error) continue;
    // 引擎级真引用（Perplexity citations）→ trust=engine，可点击
    for (const url of r.citations ?? []) {
      const domain = extractUrlDomain(url);
      if (domain) addDomain(domain, "engine", url, r.provider, r.providerLabel);
    }
    // 文本提及（DeepSeek/豆包 回答里抽出的域名）→ mentioned / suspected
    for (const d of extractCitedDomains(r.answer)) {
      addDomain(d, trustFor(d, false));
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

  const categories: CitationMapCategory[] = [...catCounts.entries()]
    .map(([category, count]) => ({ category, count, pct: Math.round((count / total) * 100) }))
    .sort((a, b) => b.count - a.count);

  const top: CitationMapItem[] = [...domMap.entries()]
    .map(([domain, v]) => ({
      domain,
      category: classifyCitationDomain(domain, entityDomain),
      count: v.count,
      pct: Math.round((v.count / total) * 100),
      trust: v.trust,
      urls: v.urls.length ? v.urls : undefined,
    }))
    .sort((a, b) => b.count - a.count || TRUST_RANK[b.trust] - TRUST_RANK[a.trust])
    .slice(0, 8);

  // 引用份额（Profound 口径）：仅引擎真引用域名，count/total 归一
  const shareTotal = domMap.size
    ? [...domMap.entries()].reduce((s, [, v]) => s + (v.trust === "engine" ? v.count : 0), 0)
    : 0;
  const share: CitationMapItem[] = shareTotal
    ? [...domMap.entries()]
        .filter(([, v]) => v.trust === "engine")
        .map(([domain, v]) => ({
          domain,
          category: classifyCitationDomain(domain, entityDomain),
          count: v.count,
          pct: Math.round((v.count / shareTotal) * 100),
          trust: "engine" as const,
          urls: v.urls,
        }))
        .sort((a, b) => b.count - a.count)
    : [];

  const ownCount = catCounts.get("官网") ?? 0;
  const hasOwnSite = ownCount > 0;
  const ownPct = Math.round((ownCount / total) * 100);
  const lead = categories[0];
  // 真引用口径下官网份额（share 只含引擎真引用）
  const ownSharePct = share.find((s) => s.category === "官网")?.pct ?? 0;

  const headline = citations.length
    ? ownSharePct > 0
      ? `溯源：AI 搜索引擎引用了 ${citations.length} 个真实来源，你的官网占引用份额 ${ownSharePct}%。把「官网」在 AI 引用池里的份额做起来。`
      : `溯源：AI 搜索引擎引用了 ${citations.length} 个真实来源，但没引用你的官网——它优先相信「${lead?.category ?? "其他"}」等来源（${lead?.pct ?? 0}%）。`
    : hasOwnSite
      ? `你的官网已被 AI 提及 ${ownCount}/${total}（${ownPct}%）。继续扩大官网可检索内容，把「主要信息源」地位坐实。`
      : entityDomain
        ? `你的网站明明写了，但 AI 根本没把你当成主要信息源——它优先相信「${lead?.category ?? "其他"}」等来源（${lead?.pct ?? 0}%）。`
        : `溯源：AI 回答提到了 ${total} 个来源域名，「${lead?.category ?? "其他"}」类占 ${lead?.pct ?? 0}%。要让 AI 引用你，先让官网与内容可被检索。`;

  return { total, categories, top, hasOwnSite, headline, citations, share, trustSummary };
}

/* ---------- 结论与建议 ---------- */

export function verdictFor(score: number, type: InputType): string {
  if (type === "question") {
    return score >= 60 ? "AI 回答质量较高" : score >= 40 ? "AI 回答一般" : "AI 回答质量较低";
  }
  if (score >= 80) return "AI 认知清晰";
  if (score >= 60) return "AI 有基础认知";
  if (score >= 40) return "AI 认知模糊";
  return "AI 尚未认知";
}

function tipsFor(type: InputType, mentionFailed: boolean, depthFailed: boolean, sourceFailed: boolean, score: number): string[] {
  const tips: string[] = [];
  if (score >= 80) {
    tips.push("保持内容更新与多平台联动，AI 认知会持续巩固。");
    return tips;
  }
  if (mentionFailed) {
    tips.push("AI 未提及你：建立可被检索的公开信息源（官网、知乎、GitHub、公众号），各平台统一「品牌名 + 一句话定位」口径。");
  }
  if (depthFailed) {
    tips.push("AI 描述不足：在官网提供清晰的价值主张、产品/服务说明与 FAQ，并加上结构化数据（Schema.org）。");
  }
  if (sourceFailed) {
    tips.push("AI 未引用来源：让官网可被 AI 爬取（sitemap、robots 放行 AI 爬虫、开放公开内容），并在平台简介统一挂官网链接。");
  }
  if (!tips.length) {
    tips.push("定期检测观察趋势；在知乎/GitHub 等 AI 语料高权重平台持续产出同口径内容。");
  }
  return tips.slice(0, 4);
}

/* ---------- 执行一次检测 ---------- */

/** B 方案溯源：附带给引擎的来源引导（让纯文本引擎尽量给出可追踪来源；报告仍存原问题） */
const SOURCE_PROMPT = "（回答时如涉及信息来源，请给出真实来源链接或平台名称；不确定来源时请勿编造链接）";

export async function runCheck(query: string): Promise<CheckReport> {
  const { type, entity, entityLabel, questions } = classify(query);
  const apiProviders = providers.filter((p) => p.kind === "api");

  const tasks = apiProviders.flatMap((p) =>
    questions.map(async (q): Promise<CheckResult> => {
      const r = await queryText(p, q + SOURCE_PROMPT);
      if (r.error) {
        return { provider: p.id, providerLabel: p.label, question: q, answer: "", mention: false, description: 0, source: false, cites: [], error: r.error, score: 0 };
      }
      const { mention, description, source, score } = scoreAnswer(entity, r.raw, type, r.citations);
      return { provider: p.id, providerLabel: p.label, question: q, answer: r.raw, mention, description, source, cites: extractCitedDomains(r.raw), citations: r.citations, score };
    })
  );
  const results = await Promise.all(tasks);

  const valid = results.filter((r) => !r.error);
  const score = valid.length ? Math.round(valid.reduce((s, r) => s + r.score, 0) / valid.length) : 0;

  const mentionFailed = valid.every((r) => !r.mention);
  const depthFailed = valid.every((r) => r.description === 0);
  const sourceFailed = valid.every((r) => !r.source);

  return {
    id: Date.now().toString(36),
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
