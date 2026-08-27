/**
 * 软文需求单（软文街 · 软文宝接入）— 闭环「优化侧 → 发布」的桥接模块
 *
 * A1 方案：geoloopos 不产软文，只产「该写什么」的结构化需求单。
 *   - 读实体档案(entities) + 知识缺口(kb.gap) + 定位锚点(anchor) + 行业问句(boards)
 *   - 按软文街发稿约束（标题 18-25 字 / 正文 800-1500 字 / 广告占比 <10%）组装多平台写作指令
 *   - 人工把需求单喂给软文街「软文宝」写软文 → 软文街一稿多发 → 收录数据回填台账
 *   - retest 复测验证 → 台账与认知曲线联动，产出软文效果回测
 *
 * 数据流：data/publish.json（台账，每条 = 一份需求单 + 发稿记录）
 * 不调 API：需求单是确定性组装（软件街软文宝负责写作），快、稳、零成本。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEntities, type EntityProfile } from "./entity.js";
import { getKB, type KnowledgeBase } from "./kb.js";
import { loadAnchor, type Anchor } from "./anchor.js";
import { listBoards } from "./boards.js";

/* ---------- 类型 ---------- */

export interface PackItem {
  /** 平台/渠道 */
  platform: string;
  /** 该平台写作提示 */
  hint: string;
  /** 建议主题（一句话） */
  topic: string;
  /** 标题建议（对齐软文街：门户 18-25 字、疑问/数字句提升点击） */
  titleSuggestion: string;
  /** 要补的知识缺口（AI 完全没提到的事实，原文引用） */
  gapToFill: string[];
  /** 必含口径：锚点句 / 关键词 / 官网链接（写软文时必须逐字带上） */
  mustContain: string[];
  /** 目标关键词（含行业问句借势） */
  keywords: string[];
  constraints: { wordCount: string; adRatio: string; style: string };
}

export interface PackPlan {
  id: string;
  entity: string;
  entityName: string;
  createdAt: string;
  source: {
    /** 最近一次认知分 0-100 */
    score: number;
    /** 知识卡被 AI 认知的完整度 0-100 */
    gapScore: number;
    /** AI 完全没提到的事实（缺口，软文要补的） */
    missing: string[];
    /** AI 现在把你看成了谁 */
    aiSummary: string;
    /** 借势行业问句 */
    scene: string;
  };
  packs: PackItem[];
}

export type PackStatus = "planned" | "exported" | "published";

export interface PublishRecord {
  id: string;
  entity: string;
  createdAt: string;
  status: PackStatus;
  notes: string;
  /** 需求单完整快照（重启后可重建 /api/packs/{id}） */
  plan: PackPlan;
  /** 发稿记录（软文街回填：一篇软文一条） */
  publications: {
    title: string;
    channel: string;
    url: string;
    collected: boolean;
    reads: number;
    publishedAt: string;
    /** 软文街订单 ID（回调按此关联） */
    orderId?: string;
  }[];
}

/* ---------- 台账 data/publish.json ---------- */

const ledgerFile = path.resolve(process.cwd(), "data/publish.json");

export function loadLedger(): PublishRecord[] {
  try {
    if (!existsSync(ledgerFile)) return [];
    return JSON.parse(readFileSync(ledgerFile, "utf-8")) as PublishRecord[];
  } catch {
    return [];
  }
}

function saveLedger(list: PublishRecord[]): void {
  writeFileSync(ledgerFile, JSON.stringify(list, null, 2) + "\n", "utf-8");
}

export function getPack(id: string): PublishRecord | null {
  return loadLedger().find((p) => p.id === id) ?? null;
}

/** 更新台账单条（局部合并），返回更新后的记录 */
export function updatePack(id: string, patch: Partial<Pick<PublishRecord, "status" | "notes" | "publications">>): PublishRecord | null {
  const list = loadLedger();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const cur = list[idx];
  list[idx] = { ...cur, ...patch };
  saveLedger(list);
  return list[idx];
}

/* ---------- 平台模板（对齐软文街发稿约束） ---------- */

interface PlatformTemplate {
  platform: string;
  hint: string;
  wordCount: string;
  style: string;
}

const PLATFORMS: PlatformTemplate[] = [
  { platform: "门户新闻稿", hint: "软文街主力渠道：一稿多发门户+自媒体，AI 收录优先级最高", wordCount: "800-1500 字", style: "干货+轻营销，广告占比 <10%，标题 18-25 字" },
  { platform: "知乎回答", hint: "AI 语料高权重，长文干货 + 客观中立口吻", wordCount: "800-2000 字", style: "干货长文，结尾挂官网/公众号链接" },
  { platform: "小红书笔记", hint: "种草口吻 + 3-5 个话题标签，封面图建议单独做", wordCount: "400-800 字", style: "口语化、分点、emoji 克制、评论区留钩子" },
  { platform: "公众号推文", hint: "案例故事体，软文街可分发微信生态", wordCount: "1000-2000 字", style: "开头抓痛点、中间讲案例、结尾给行动指引" },
];

/* ---------- 生成需求单 ---------- */

/** 标题句式（疑问/数字提升点击率；门户要求 18-25 字，其余可稍长） */
function titleFor(platform: string, kw: string, name: string): string {
  switch (platform) {
    case "门户新闻稿":
      return `成都企业做「${kw}」到底值不值？2026 年的答案变了`;
    case "知乎回答":
      return `关于「${kw}」，讲透 AI 时代品牌为什么必须被看见`;
    case "小红书笔记":
      return `被 AI 推荐的品牌都做对了这 3 件事（${kw}实测）`;
    case "公众号推文":
      return `一家成都公司的「${kw}」实验：从被 AI 无视到被引用`;
    default:
      return `${name}与「${kw}」：一个被低估的增长杠杆`;
  }
}

/** 目标实体匹配（容忍：大小写/去 www/去协议，退到子串） */
function matchEntity(list: EntityProfile[], key: string): EntityProfile | undefined {
  if (!key) return undefined;
  const norm = (s: string) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\s+/g, "");
  const nk = norm(key);
  return list.find((e) => norm(e.key) === nk) ?? list.find((e) => norm(e.name) === nk) ?? list.find((e) => e.key.toLowerCase().includes(key.toLowerCase()) || (e.name || "").toLowerCase().includes(key.toLowerCase()));
}

/** 借势行业问句：锚点/实体关键词 与 行业名 子串匹配，命中返回 ask */
function pickScene(keywords: string[], name: string): string {
  const rows = listBoards().industries ?? [];
  if (!rows.length) return "";
  const hay = [...keywords, name].filter(Boolean).join(" ");
  const hit = rows.find((r) => hay.includes(r.name) || r.name.includes(name.slice(0, 2)));
  return hit ? hit.ask : "";
}

/** 组装一份需求单（不调 LLM，确定性生成） */
export function generatePlan(opts: { entity?: string } = {}): PackPlan {
  const entities = loadEntities();
  const anchor: Anchor = loadAnchor();

  // 1. 选目标实体：显式指定 → 优先有知识卡的 → 兜底第一个有检测历史的 site/brand
  let profile = opts.entity ? matchEntity(entities, opts.entity) : undefined;
  if (!profile) {
    profile =
      entities.find((e) => getKB(e.key)?.gap) ??
      entities.find((e) => e.kind === "site" && e.checks.length > 0) ??
      entities.find((e) => e.checks.length > 0);
  }
  const entityName = (profile?.name ?? opts.entity?.trim()) || anchor.name || "目标品牌";
  const entityKey = profile?.key ?? entityName;

  // 2. 收集源数据
  const kb: KnowledgeBase | null = getKB(entityKey);
  const gap = kb?.gap;
  const score = profile?.checks.length ? profile.checks[profile.checks.length - 1].score ?? 0 : 0;

  // 3. 口径与关键词（anchor 优先，空则退 kb/实体）
  const mustContain: string[] = [];
  if (anchor.positioning) mustContain.push(anchor.positioning);
  mustContain.push(...anchor.keywords.slice(0, 3));
  if (anchor.site) mustContain.push(anchor.site);
  if (kb?.identity?.site) mustContain.push(kb.identity.site); // kb.identity.site 兜底
  if (profile?.site && !mustContain.includes(profile.site)) mustContain.push(profile.site);
  const uniqueMust = [...new Set(mustContain.filter(Boolean))];

  const keywords: string[] = [
    ...anchor.keywords.slice(0, 3),
    ...(kb?.keywords ?? []).slice(0, 3),
    ...(profile?.keywords ?? []).slice(0, 2),
  ];
  const uniqueKw = [...new Set(keywords.filter(Boolean))].slice(0, 5);
  const scene = pickScene(uniqueKw, entityName);

  // 4. 缺口
  const missing = gap?.missing ?? [];
  const gapToFill = missing.length ? missing : gap?.weakList ?? [];
  const sceneText = scene || `「${uniqueKw[0] ?? entityName}」相关行业话题`;

  // 5. 组装各平台需求
  const kw0 = uniqueKw[0] ?? entityName;
  const packs: PackItem[] = PLATFORMS.map((t) => ({
    platform: t.platform,
    hint: t.hint,
    topic: gapToFill[0] ? `补认知缺口：${gapToFill[0]}` : `围绕「${kw0}」做一次品牌科普，让 AI 有据可循`,
    titleSuggestion: titleFor(t.platform, kw0, entityName),
    gapToFill: gapToFill.slice(0, 3),
    mustContain: uniqueMust,
    keywords: uniqueKw,
    constraints: { wordCount: t.wordCount, adRatio: "广告占比 <10%（门户硬性）", style: t.style },
  }));

  const plan: PackPlan = {
    id: "pk-" + Date.now().toString(36),
    entity: entityKey,
    entityName,
    createdAt: new Date().toISOString(),
    source: {
      score,
      gapScore: gap?.score ?? -1,
      missing,
      aiSummary: gap?.aiSummary ?? "",
      scene: sceneText,
    },
    packs,
  };

  // 6. 入台账（带 plan 快照）
  const ledger = loadLedger();
  ledger.push({
    id: plan.id,
    entity: entityKey,
    createdAt: plan.createdAt,
    status: "planned",
    notes: "",
    plan,
    publications: [],
  });
  saveLedger(ledger);

  return plan;
}

/* ---------- 导出：需求单 → 可直接喂给软文宝的文本 ---------- */

/** 把一份需求单渲染成「软文宝」可用的写作指令文本（整份导出） */
export function renderExportText(plan: PackPlan): string {
  const lines: string[] = [];
  lines.push(`# 软文需求单 · ${plan.entityName}（${plan.id}）`);
  lines.push(`生成时间：${plan.createdAt.slice(0, 10)}`);
  lines.push("");
  lines.push(`## 背景（给写手看）`);
  lines.push(`- 目标实体：${plan.entityName}`);
  lines.push(`- 最近 AI 认知分：${plan.source.score} / 100；知识卡被认知完整度：${plan.source.gapScore < 0 ? "未分析" : plan.source.gapScore + "%"}`);
  lines.push(`- 借势话题：${plan.source.scene}`);
  if (plan.source.aiSummary) lines.push(`- AI 现在这么看我：「${plan.source.aiSummary}」`);
  if (plan.source.missing.length) {
    lines.push(`- 要补的认知缺口（AI 完全没提到的）：${plan.source.missing.join("；")}`);
  }
  lines.push("");
  lines.push(`## 通用硬性要求（所有稿件）`);
  lines.push(`- 必须逐字包含以下口径/关键词：${[...new Set(plan.packs[0]?.mustContain ?? [])].join(" / ")}`);
  lines.push(`- 目标关键词：${plan.packs[0]?.keywords.join("、") ?? ""}`);
  lines.push(`- 广告占比 <10%，正文以干货为主；真实来源链接，禁止编造`);
  lines.push("");
  lines.push(`## 分平台稿件（${plan.packs.length} 篇）`);
  for (const p of plan.packs) {
    lines.push("");
    lines.push(`### 【${p.platform}】${p.titleSuggestion}`);
    lines.push(`- 写作提示：${p.hint}`);
    lines.push(`- 建议字数：${p.constraints.wordCount}；风格：${p.constraints.style}`);
    lines.push(`- 主题：${p.topic}`);
    if (p.gapToFill.length) lines.push(`- 务必覆盖这些事实（AI 现在不知道）：${p.gapToFill.join("；")}`);
  }
  lines.push("");
  lines.push(`> 用「软文宝」按上述要求写各平台稿件，完成后在软文街提交发布。`);
  return lines.join("\n");
}
