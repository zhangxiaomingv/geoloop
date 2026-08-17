/**
 * 定位锚点 — 一套「标准答案」，各平台统一口径的来源。
 *
 * 核心思路：一致性靠「生成时强制」，不靠事后比对。
 * 用户在这里定义一次名称/定位/关键词/官网，系统按各平台字数限制
 * 生成长/中/短三个统一版本 + 站点署名代码片段，用户复制粘贴即可，
 * 保证任何平台抓到的品牌画像逐字一致。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Anchor {
  /** 认证名称 */
  name: string;
  /** 一句话定位 */
  positioning: string;
  /** 3 个左右核心关键词 */
  keywords: string[];
  /** 官网链接 */
  site: string;
  /** 可选：较长的一段介绍（服务/产品/内容方向，仅用于长版平台） */
  bio?: string;
}

/** 各平台：版本档位 + 提示 */
export interface AnchorPlatform {
  id: string;
  label: string;
  version: "long" | "medium" | "short";
  hint: string;
}

export const PLATFORMS: AnchorPlatform[] = [
  { id: "zhihu", label: "知乎", version: "long", hint: "个人简介 · 可写完整" },
  { id: "wechat", label: "公众号", version: "long", hint: "公众号简介 · 可写完整" },
  { id: "weibo", label: "微博", version: "medium", hint: "个人简介 · 约 70 字" },
  { id: "xhs", label: "小红书", version: "medium", hint: "个人简介 · 约 70 字" },
  { id: "douyin", label: "抖音", version: "short", hint: "个人简介 · 一句话" },
  { id: "bilibili", label: "B站", version: "short", hint: "个人简介 · 一句话" },
  { id: "github", label: "GitHub", version: "short", hint: "个人主页 bio · 一句话" },
];

export function defaultAnchor(): Anchor {
  return { name: "", positioning: "", keywords: [], site: "", bio: "" };
}

/** 生成长/中/短三个统一口径版本 */
export function generateVersions(a: Anchor): Record<"long" | "medium" | "short", string> {
  const kw = a.keywords.join("、");
  const p = a.positioning.replace(/[。.]+$/, "");
  return {
    long: [a.name, p, kw, a.site, a.bio].filter(Boolean).join("｜"),
    medium: [a.name, p, kw, a.site].filter(Boolean).join(" · "),
    short: [a.name, p, a.site].filter(Boolean).join("｜"),
  };
}

/** 为某个平台生成就绪简介 */
export function versionForPlatform(a: Anchor, platform: AnchorPlatform): string {
  return generateVersions(a)[platform.version];
}

/** 站点署名代码片段 —— 贴到 CMS 模板，所有文章自动带署名与站点归属 */
export function siteSnippet(a: Anchor): string {
  const kw = a.keywords.join(",");
  const head = `<link rel="canonical" href="{{POST_URL}}">\n<meta name="author" content="${a.name}">\n<meta name="keywords" content="${kw}">`;
  const card = [
    `<!-- 文章底部作者卡片（全站统一口径，复制进组件模板即可） -->`,
    `export default function AuthorCard() {`,
    `  return (`,
    `    <aside className="author-card">`,
    `      <a href="${a.site}"><strong>${a.name}</strong></a>`,
    `      <p>${a.positioning}</p>`,
    `      <a href="${a.site}">${a.site.replace(/^https?:\/\//, "")}</a>`,
    `    </aside>`,
    `  );`,
    `}`,
  ].join("\n");
  return head + "\n\n" + card;
}

/* ---------- 持久化 data/anchor.json ---------- */

const file = path.resolve(process.cwd(), "data/anchor.json");

export function loadAnchor(): Anchor {
  try {
    if (!existsSync(file)) return defaultAnchor();
    const a = JSON.parse(readFileSync(file, "utf-8")) as Partial<Anchor>;
    return {
      name: a.name ?? "",
      positioning: a.positioning ?? "",
      keywords: Array.isArray(a.keywords) ? a.keywords : [],
      site: a.site ?? "",
      bio: a.bio ?? "",
    };
  } catch {
    return defaultAnchor();
  }
}

export function saveAnchor(a: Anchor): void {
  writeFileSync(file, JSON.stringify(a, null, 2) + "\n", "utf-8");
}
