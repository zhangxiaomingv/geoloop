/**
 * 竞品对比 — 你 vs 竞品在 AI 眼中的可见度差距。
 *
 * 企业客户最关心「我比对手好在哪」。对每个实体复用 check.ts 的
 * 分类 + 评分口径做轻量检测（每实体 1 问 × 2 源，比完整 runCheck 快），
 * 输出横向排名 + 领先者 + 差距洞察 + 针对性的抢占建议。
 */

import { providers } from "../config.js";
import { queryText } from "./providers.js";
import { classify, scoreAnswer, verdictFor, extractCitedDomains, InputType } from "./check.js";
import type { CheckResult } from "./check.js";

export interface CompareEntity {
  /** 原始输入（用于标识 self） */
  name: string;
  type: InputType;
  entity: string;
  score: number;
  verdict: string;
  /** 认识它的源数 / 有效源数 */
  recognized: number;
  total: number;
  /** 平均描述深度（0/15/30 加权） */
  depth: number;
  /** 引用来源的源数 */
  sources: number;
  results: CheckResult[];
}

export interface CompareReport {
  self: string;
  competitors: string[];
  entities: CompareEntity[];      // 按分数降序
  rankOfSelf: number;
  leader: string;
  gap: number;                    // 最高分 - 自己分（领先则为负/0）
  insights: string[];
  checkedAt: string;
}

const MAX_ENTITIES = 6;

/** 对单个实体做轻量检测（第一问 × 全部 API 源） */
async function probeEntity(input: string): Promise<CompareEntity> {
  const { type, entity, questions } = classify(input);
  const apiProviders = providers.filter((p) => p.kind === "api");
  const q0 = questions[0];

  const results = await Promise.all(
    apiProviders.map(async (p): Promise<CheckResult> => {
      const r = await queryText(p, q0);
      if (r.error) {
        return { provider: p.id, providerLabel: p.label, question: q0, answer: "", mention: false, description: 0, source: false, cites: [], error: r.error, score: 0 };
      }
      const s = scoreAnswer(entity, r.raw, type);
      return { provider: p.id, providerLabel: p.label, question: q0, answer: r.raw, ...s, cites: extractCitedDomains(r.raw) };
    })
  );

  const valid = results.filter((r) => !r.error);
  const score = valid.length ? Math.round(valid.reduce((s, r) => s + r.score, 0) / valid.length) : 0;
  const depth = valid.length ? Math.round(valid.reduce((s, r) => s + r.description, 0) / valid.length) : 0;

  return {
    name: input,
    type,
    entity,
    score,
    verdict: verdictFor(score, type),
    recognized: valid.filter((r) => r.mention).length,
    total: valid.length,
    depth,
    sources: valid.filter((r) => r.source).length,
    results,
  };
}

/** 串行跑各实体（并发会打爆 API 源），每实体内部各源并行 */
export async function runCompare(self: string, competitors: string[]): Promise<CompareReport> {
  const all = [self, ...competitors].map((s) => s.trim()).filter(Boolean).slice(0, MAX_ENTITIES);
  const entities: CompareEntity[] = [];
  for (const name of all) {
    entities.push(await probeEntity(name));
  }

  const ranked = [...entities].sort((a, b) => b.score - a.score);
  const selfE = entities.find((e) => e.name === self.trim());
  const leader = ranked[0];
  const rankOfSelf = ranked.findIndex((e) => e === selfE) + 1;

  const insights = buildInsights(selfE, leader, rankOfSelf, entities.length);

  return {
    self: self.trim(),
    competitors: all.slice(1),
    entities: ranked,
    rankOfSelf,
    leader: leader?.name ?? "",
    gap: selfE ? leader.score - selfE.score : 0,
    insights,
    checkedAt: new Date().toISOString(),
  };
}

function buildInsights(selfE: CompareEntity | undefined, leader: CompareEntity, rank: number, n: number): string[] {
  if (!selfE) return [];
  const tips: string[] = [];

  if (rank === 1) {
    tips.push(`你在 ${n} 个对比对象中领先（${selfE.score} 分），保持内容更新 + 口径统一即可持续巩固。`);
    return tips;
  }

  const gap = leader.score - selfE.score;
  tips.push(`当前与最高分（${leader.name}，${leader.score} 分）差 ${gap} 分，排第 ${rank}。`);

  if (selfE.recognized === 0) {
    tips.push("首要缺口：AI 对你还缺乏认知。先把锚点简介全平台统一复制，让官网可被检索——先被认识，再谈描述。");
  } else if (selfE.depth < 15) {
    tips.push("描述不足：AI 认识你但讲不清。补全锚点定位句，让官网与各平台简介把「你是谁、做什么」说完整。");
  } else if (selfE.sources === 0) {
    tips.push("来源缺失：AI 敢说不敢引。让官网可被 AI 爬取（sitemap/robots），各平台简介统一挂官网链接。");
  }

  // 看领先者赢在哪
  const leaderWins: string[] = [];
  if (leader.recognized > selfE.recognized) leaderWins.push("认知覆盖更广");
  if (leader.depth > selfE.depth) leaderWins.push("描述更完整");
  if (leader.sources > selfE.sources) leaderWins.push("来源引用更强");
  if (leaderWins.length) tips.push(`对手 ${leader.name} 在「${leaderWins.join("、")}」上超过你，可对照它的公开资料做差异补齐。`);

  if (tips.length < 2) tips.push("对比各源回答原文，看对手做对了什么（内容量 / 权威源 / 口径统一），逐条补齐。");
  return tips.slice(0, 4);
}

/* ================= 场景认知（Competitor Intelligence · 模式 B） =================
 * 不直接比品牌，而是站在「用户真实问题」场景里：把场景问题抛给各 AI 源，
 * 看它们的回答中谁被提及/推荐，算各品牌在 AI 推荐里的曝光份额（如 A 70% / B 20% / 你 0%），
 * 并给出「0 曝光的根因：缺案例 / 缺 FAQ / 缺行业实体关系」类洞察。 */

export interface SceneEntity {
  name: string;
  /** 被几个有效源提及/推荐 */
  mentions: number;
  /** 有效源总数 */
  total: number;
  /** 曝光份额 0-100 */
  share: number;
  mentionedBy: string[];
}

export interface SceneCompareReport {
  mode: "scene";
  scene: string;
  self: string;
  entities: SceneEntity[];
  rankOfSelf: number;
  leader: string;
  gapShare: number;
  insights: string[];
  samples: { providerLabel: string; answer: string }[];
  checkedAt: string;
}

/** 品牌是否在回答中被提及/推荐（长度 ≥2 才匹配，避免「公司」这类通用词误判） */
function mentionOf(answer: string, name: string): boolean {
  const n = name.trim();
  if (n.length < 2) return false;
  return answer.includes(n);
}

export async function runSceneCompare(scene: string, names: string[]): Promise<SceneCompareReport> {
  const apiProviders = providers.filter((p) => p.kind === "api");
  const list = [...new Set(names.map((s) => s.trim()).filter(Boolean))].slice(0, MAX_ENTITIES);

  const samples = await Promise.all(
    apiProviders.map(async (p) => {
      const r = await queryText(p, scene);
      return { providerLabel: p.label, answer: r.error ? "" : r.raw };
    })
  );
  const valid = samples.filter((s) => s.answer);

  const entities: SceneEntity[] = list
    .map((name) => {
      const mentionedBy = valid.filter((s) => mentionOf(s.answer, name)).map((s) => s.providerLabel);
      return {
        name,
        mentions: mentionedBy.length,
        total: valid.length,
        share: valid.length ? Math.round((mentionedBy.length / valid.length) * 100) : 0,
        mentionedBy,
      };
    })
    .sort((a, b) => b.share - a.share);

  const selfE = entities.find((e) => e.name === list[0]);
  const rankOfSelf = selfE ? entities.findIndex((e) => e === selfE) + 1 : 0;
  const leader = entities[0];

  return {
    mode: "scene",
    scene,
    self: list[0] ?? "",
    entities,
    rankOfSelf,
    leader: leader?.name ?? "",
    gapShare: selfE && leader ? leader.share - selfE.share : 0,
    insights: buildSceneInsights(selfE, leader, rankOfSelf, entities.length),
    samples,
    checkedAt: new Date().toISOString(),
  };
}

function buildSceneInsights(selfE: SceneEntity | undefined, leader: SceneEntity, rank: number, n: number): string[] {
  if (!selfE) return ["请填写你的品牌名。"];
  const tips: string[] = [];

  if (rank === 1) {
    tips.push(`这个场景下 AI 回答中最先推荐你（曝光 ${selfE.share}%）。持续把品牌名与场景关键词绑定发布内容，锁定认知。`);
    return tips;
  }

  tips.push(`该场景 AI 更偏好 ${leader.name}（${leader.share}%），你的品牌曝光 ${selfE.share}%，排第 ${rank}。`);

  if (selfE.share === 0) {
    tips.push("0 曝光 = AI 在这个场景的候选名单里没有你。最常见的三类根因：");
    tips.push("① 缺案例：没有「场景 + 落地项目/客户案例」内容，AI 不敢推荐没有实证的品牌；");
    tips.push("② 缺 FAQ/服务页：官网缺少针对该需求的 FAQ、报价或服务说明，AI 无法确认你能承接；");
    tips.push("③ 缺行业实体关系：品牌名从未与场景关键词同框出现，AI 建立不了「你=该场景的答案」的关联。");
    tips.push("行动：发布 3-5 篇「[场景关键词] + 品牌名」的案例/FAQ 内容，全平台口径统一，让场景词与品牌名一起被 AI 读到。");
  } else {
    tips.push(`你被 ${selfE.mentions}/${selfE.total} 个源提及，但份额低于 ${leader.name}。补齐「案例 + FAQ + 场景词内容」，把份额抢回来。`);
  }
  return tips.slice(0, 6);
}
