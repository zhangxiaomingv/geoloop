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
  /** 来源：是否引用了可追溯来源（站点模式=引用了该域名） */
  source: boolean;
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

export function scoreAnswer(entity: string, answer: string, type: InputType): { mention: boolean; description: 0 | 15 | 30; source: boolean; score: number } {
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

  const source = type === "site" ? sourceForSite(text, entity) : ANY_SOURCE_RE.test(text);

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

export async function runCheck(query: string): Promise<CheckReport> {
  const { type, entity, entityLabel, questions } = classify(query);
  const apiProviders = providers.filter((p) => p.kind === "api");

  const tasks = apiProviders.flatMap((p) =>
    questions.map(async (q): Promise<CheckResult> => {
      const r = await queryText(p, q);
      if (r.error) {
        return { provider: p.id, providerLabel: p.label, question: q, answer: "", mention: false, description: 0, source: false, error: r.error, score: 0 };
      }
      const { mention, description, source, score } = scoreAnswer(entity, r.raw, type);
      return { provider: p.id, providerLabel: p.label, question: q, answer: r.raw, mention, description, source, score };
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
  };
}
