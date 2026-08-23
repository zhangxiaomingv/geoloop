/**
 * GEOloopOS Identity Engine · 配置 — 模型源在此文件调整
 * 产品端检测走 API 即时查询（DeepSeek / 豆包），无需固定问题集。
 */

export interface Question {
  id: string;
  text: string;        // 问 AI 的问题
  targets: string[];   // 命中判定：回答出现任一即算「提到品牌」
  descriptors: string[]; // 一致性判定：期望出现的身份/服务描述词
  officialUrls: string[]; // 来源判定：期望出现的官方 URL（可省略域名）
}

export interface Provider {
  id: string;
  label: string;
  kind: "api" | "browser" | "manual";
  /** API 专用 */
  baseUrl?: string;
  model?: string;
  /** API Key 的环境变量名（默认 DEEPSEEK_API_KEY） */
  apiKeyEnv?: string;
  /** 浏览器专用：{query} 会被替换 */
  urlTemplate?: string;
  /**
   * 排除出「行业榜批量采样」（boards.ts 的 generateBoard）。
   * 置 true 的源（如付费/带引用的 Perplexity）只进产品检测，不拖累 360 行业批量生成。
   */
  excludeFromSampling?: boolean;
}

/**
 * 模型源 — 产品检测用 API 源（快、稳、公网友好）
 *  DeepSeek / 豆包：OpenAI 兼容，各需自己的 Key（配置在 .env）
 */
export const providers: Provider[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "api",
    baseUrl: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
  },
  {
    id: "doubao",
    label: "豆包",
    kind: "api",
    // 火山方舟（火山引擎）OpenAI 兼容 API；Key 在 console.volcengine.com 开通方舟后获取
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    // 默认模型名（账号可调用 doubao-seed-2-0-pro），可用环境变量 DOUBAO_MODEL 覆盖（或填方舟 endpoint ID ep-xxx）
    model: process.env.DOUBAO_MODEL || "doubao-seed-2-0-pro-260215",
    apiKeyEnv: "ARK_API_KEY",
  },
  // ── 真引用引擎（可选，默认未启用）──────────────────────────────
  // 溯源模块当前走「B 方案」：纯文本抽取 + prompt 引导，仅 DeepSeek/豆包。
  // 以后有条件接入带 citations 元数据的引擎（如 Perplexity），
  // 把下面这段取消注释 + .env 配 PPLX_API_KEY 即启用真引用路径。
  // {
  //   id: "perplexity",
  //   label: "Perplexity",
  //   kind: "api",
  //   baseUrl: "https://api.perplexity.ai/chat/completions",
  //   model: process.env.PERPLEXITY_MODEL || "sonar",
  //   apiKeyEnv: "PPLX_API_KEY",
  //   excludeFromSampling: true,
  // },
];
