/**
 * 文章监测 — 内容型 GEO 的核心资产跟踪。
 *
 * 品牌名检测回答「AI 认不认识你」；文章监测回答「AI 有没有真的采用你的内容」。
 * 对每篇文章按「主题」问 AI 推荐，判定：
 *   - 站点域名是否被引用（站点级）
 *   - 文章 URL 路径是否被精确引用（文章级）
 *   - 文章标题是否被提及（内容级）
 *
 * 与 check.ts 相同：只用 API 源（DeepSeek + 豆包），稳定快速。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { providers } from "../config.js";
import { queryText } from "./providers.js";
import type { Provider } from "../config.js";

export interface Article {
  id: string;
  title: string;
  url: string;
  /** 主题关键词：用于向 AI 提问推荐 */
  topic: string;
  createdAt: string;
  lastCheck?: ArticleCheck;
}

export interface ArticleResult {
  provider: string;
  providerLabel: string;
  question: string;
  answer: string;
  error?: string;
  siteCited: boolean;      // 回答引用了文章所在域名
  articleCited: boolean;   // 回答精确引用了该文章 URL
  titleMentioned: boolean; // 回答提及了文章标题
  score: number;
}

export interface ArticleCheck {
  checkedAt: string;
  results: ArticleResult[];
  score: number;        // 各源均分
  verdict: string;
  siteCitedBy: string[];    // 引用了站点的源
  articleCitedBy: string[]; // 精确引用了该文章的源
}

/* ---------- 引用判定 ---------- */

/** 提取 URL 的可识别片段：域名 + 去协议去参数 + 非空路径段 */
function urlFragments(url: string): { domain: string; path: string } {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter((s) => s.length >= 4);
    return { domain: u.hostname.replace(/^www\./, ""), path: segs.join("/") };
  } catch {
    // 容错：手动兜底域名
    const m = url.match(/(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,})/);
    return { domain: m?.[1] ?? "", path: "" };
  }
}

/** 标题取一句可辨识短语（太长/太通用会降低置信度） */
function titlePhrase(title: string): string {
  const t = title.trim();
  if (t.length >= 6) return t;
  return "";
}

/** 问 AI 推荐该主题内容，并判定文章是否被采用 */
async function probeArticle(provider: Provider, article: Article): Promise<ArticleResult> {
  const question = `关于「${article.topic}」这个话题，有哪些值得推荐的文章、资料或网站？请给出具体链接。`;
  const { domain, path } = urlFragments(article.url);

  const r = await queryText(provider, question);
  if (r.error) {
    return { provider: provider.id, providerLabel: provider.label, question, answer: "", error: r.error, siteCited: false, articleCited: false, titleMentioned: false, score: 0 };
  }
  const ans = r.raw;
  const siteCited = Boolean(domain) && ans.includes(domain);
  const articleCited = siteCited && Boolean(path) && path.split("/").some((seg) => ans.includes(seg));
  const phrase = titlePhrase(article.title);
  const titleMentioned = Boolean(phrase) && ans.includes(phrase);

  const score = articleCited ? 80 : siteCited ? 50 : titleMentioned ? 30 : 0;
  return { provider: provider.id, providerLabel: provider.label, question, answer: ans, siteCited, articleCited, titleMentioned, score };
}

/** 监测单篇文章（API 源并行） */
export async function checkArticle(article: Article): Promise<ArticleCheck> {
  const apiProviders = providers.filter((p) => p.kind === "api");
  const results = await Promise.all(apiProviders.map((p) => probeArticle(p, article)));

  const valid = results.filter((r) => !r.error);
  const score = valid.length ? Math.round(valid.reduce((s, r) => s + r.score, 0) / valid.length) : 0;
  const verdict = score >= 65 ? "文章被 AI 引用" : score >= 40 ? "站点被 AI 提到" : "尚未被采用";

  return {
    checkedAt: new Date().toISOString(),
    results,
    score,
    verdict,
    siteCitedBy: valid.filter((r) => r.siteCited).map((r) => r.providerLabel),
    articleCitedBy: valid.filter((r) => r.articleCited).map((r) => r.providerLabel),
  };
}

/** 批量监测：串行跑文章（避免同时打爆 API 源），每篇内部各源并行 */
export async function checkArticles(articles: Article[]): Promise<Article[]> {
  for (const a of articles) {
    if (!a.url) continue;
    a.lastCheck = await checkArticle(a);
  }
  return articles;
}

/* ---------- 持久化 data/articles.json ---------- */

const file = path.resolve(process.cwd(), "data/articles.json");

export function loadArticles(): Article[] {
  try {
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, "utf-8")) as Article[];
  } catch {
    return [];
  }
}

export function saveArticles(articles: Article[]): void {
  writeFileSync(file, JSON.stringify(articles, null, 2) + "\n", "utf-8");
}
