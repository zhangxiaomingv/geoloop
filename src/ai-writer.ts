/**
 * AI 写稿 — 按软文需求单生成可发布的 HTML 成稿（供软文街 API 下单）
 *
 * 用 DeepSeek（复用 providers 封装）把 pack.ts 的「该写什么」需求单
 * 转成「写好的稿子」。输出 HTML 段落（软文街 content 字段要求 HTML 格式）。
 *
 * 设计：
 *   - 一篇 pack 一稿，标题用 pack.titleSuggestion（门户 18-25 字约束）
 *   - 强制覆盖 mustContain 口径 / gapToFill 事实 / keywords（需求单里已聚合）
 *   - 广告占比 <10%（门户硬性），正文干货为主
 *   - HTML 用 <p>/<h3>/<strong>，禁止脚本/外链（外链由软文街媒体 url_type 决定）
 *
 * 零成本？No —— 调一次 DeepSeek。但比人工写稿快，且每稿成本约几分钱。
 */

import type { PackItem, PackPlan } from "./pack.js";
import type { Provider } from "../config.js";

export interface WriteResult {
  platform: string;
  title: string;
  contentHtml: string;
  ok: boolean;
  error?: string;
}

/** 单篇写作 prompt：把需求单约束转成写作指令 */
function buildPrompt(plan: PackPlan, pack: PackItem): string {
  const lines: string[] = [];
  lines.push("你是资深软文写手。请按以下要求写一篇可直接发布的软文，只输出 HTML 正文（<p>、<h3>、<strong>、<ul> 等标签），不要 Markdown，不要输出标题外的任何说明文字。");
  lines.push("");
  lines.push(`目标实体：${plan.entityName}`);
  lines.push(`平台：${pack.platform}`);
  lines.push(`标题：${pack.titleSuggestion}`);
  lines.push(`建议字数：${pack.constraints.wordCount}`);
  lines.push(`风格：${pack.constraints.style}`);
  lines.push(`写作提示：${pack.hint}`);
  lines.push(`主题：${pack.topic}`);
  if (pack.gapToFill.length) lines.push(`务必覆盖这些事实（AI 现在不知道，是本次发稿要补的）：${pack.gapToFill.join("；")}`);
  if (pack.mustContain.length) lines.push(`必须逐字包含以下口径/关键词（写作时原样带上）：${pack.mustContain.join(" / ")}`);
  if (pack.keywords.length) lines.push(`目标关键词：${pack.keywords.join("、")}`);
  lines.push(`广告占比必须 <10%，正文以干货为主，禁止编造数据。`);
  return lines.join("\n");
}

/** 生成单篇 HTML 稿件 */
export async function writeArticle(plan: PackPlan, pack: PackItem): Promise<WriteResult> {
  const { providers } = await import("../config.js");
  const { queryText } = await import("./providers.js");
  const deepseek: Provider | undefined = providers.find((p: Provider) => p.id === "deepseek");
  if (!deepseek) return { platform: pack.platform, title: pack.titleSuggestion, contentHtml: "", ok: false, error: "DeepSeek 源未配置" };

  const res = await queryText(deepseek, buildPrompt(plan, pack));
  if (res.error || !res.raw) return { platform: pack.platform, title: pack.titleSuggestion, contentHtml: "", ok: false, error: res.error || "AI 未返回内容" };

  return {
    platform: pack.platform,
    title: pack.titleSuggestion,
    contentHtml: res.raw,
    ok: true,
  };
}

/** 为一份需求单写全部平台稿件（并行） */
export async function writeAllArticles(plan: PackPlan): Promise<WriteResult[]> {
  const results = await Promise.all(plan.packs.map((p) => writeArticle(plan, p)));
  return results;
}
