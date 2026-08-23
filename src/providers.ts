import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Provider, Question } from "../config.js";

const execFileAsync = promisify(execFile);

export interface QueryResult {
  raw: string;
  error?: string;
  /**
   * 引擎级真引用（Perplexity 等带 citations 元数据的源返回）。
   * URL 数组；纯文本源（DeepSeek/豆包）无此字段，引用只能靠从 raw 里抽取。
   */
  citations?: string[];
}

/** 按 provider.kind 分发查询 */
export async function query(provider: Provider, question: Question): Promise<QueryResult> {
  switch (provider.kind) {
    case "api":
      return queryApi(provider, question.text);
    case "browser":
      return queryBrowser(provider, question.text);
    case "manual":
      return queryManual(provider, question);
  }
}

/** 面向任意文本的 API 即时查询（产品端检测用）：不走 config 问题集，直接问 API 源 */
export async function queryText(provider: Provider, text: string): Promise<QueryResult> {
  if (provider.kind !== "api") {
    return { raw: "", error: `${provider.label} 不是 API 源，无法用于即时检测` };
  }
  return queryApi(provider, text);
}

/* ---------- API（DeepSeek / 豆包，OpenAI 兼容） ---------- */

async function queryApi(provider: Provider, text: string): Promise<QueryResult> {
  const keyEnv = provider.apiKeyEnv ?? "DEEPSEEK_API_KEY";
  const key = process.env[keyEnv];
  if (!key) return { raw: "", error: `缺少 ${keyEnv}（在项目 .env 或环境变量设置，开通渠道见 README）` };

  // 超时/网络失败重试 1 次（API 偶发慢/断连，重试成本低收益高）
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(provider.baseUrl!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: "user", content: text }],
          temperature: 0.2,
          // Perplexity：显式要求返回 citations（默认也回，兜底旧接口行为）
          ...(provider.id === "perplexity" ? { return_citations: true } : {}),
        }),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) return { raw: "", error: `API ${res.status}: ${(await res.text()).slice(0, 200)}` };
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        /** Perplexity 等带 citations 元数据的源 */
        citations?: string[];
      };
      const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
      // 有 citations 的源（Perplexity）→ 引擎真引用；其余源 raw 非空但无 citations（显式引用靠文本抽取）
      const citations = Array.isArray(data.citations) ? data.citations.filter((u): u is string => typeof u === "string" && u.startsWith("http")) : undefined;
      return { raw, citations: citations?.length ? citations : undefined };
    } catch (e) {
      if (attempt === 2) return { raw: "", error: `API 异常: ${(e as Error).message}` };
      await new Promise((r) => setTimeout(r, 1500)); // 首次失败短暂等待后重试
    }
  }
  return { raw: "", error: "API 重试次数耗尽" };
}

/* ---------- 浏览器自动化（系统无头 Chrome） ---------- */

function findChrome(): string | null {
  const candidates = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
    "brave-browser",
    "microsoft-edge",
  ];
  for (const c of candidates) {
    try {
      execFileSyncCheck(c);
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function execFileSyncCheck(name: string): void {
  execFileSync("which", [name], { stdio: "ignore" });
}

/** 清洗 DOM → 纯文本（去脚本/样式/标签，压缩空白） */
function cleanupDom(dom: string): string {
  return dom
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 页面外壳 / 无效内容的特征标记 —— 命中任一说明抓到的是站点 UI 而非回答。
 * 实测秘塔在限流/未渲染时会给「手机端扫码」「PDF 讲题控件」等壳页面，
 * 问题文本被回显会伪造出分数，必须按失败处理防止数据污染。
 */
const JUNK_MARKERS = [
  "选择讲题范围", // 秘塔 PDF 讲题控件
  "扫码免费使用", // 秘塔手机端引导
  "共0页",        // PDF 控件空态
  "手机端",       // 移动端提示
  "请登录",       // 登录墙
  "登录后",       // 登录墙
];

async function queryBrowser(provider: Provider, text: string): Promise<QueryResult> {
  const chrome = findChrome();
  if (!chrome) return { raw: "", error: "未找到系统 Chrome，浏览器自动化不可用（可改用 manual 源）" };

  const url = provider.urlTemplate!.replace("{query}", encodeURIComponent(text));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-software-rasterizer",
    "--virtual-time-budget=8000",
    "--dump-dom",
    url,
  ];
  // 异步 execFile：不阻塞事件循环；stderr 丢弃，静默 GPU 噪音。
  // 注：Node 运行时 execFile 透传 spawn 的 stdio 选项，但 @types 定义滞后 → 交叉类型补上
  const execOpts = {
    encoding: "utf-8" as const,
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"] as const,
  } as import("node:child_process").ExecFileOptions & { stdio: ["ignore", "pipe", "ignore"] };

  try {
    // run.ts 已串行执行浏览器源（秘塔并发限流）；这里空结果时冷却重试一次兜底瞬时失败/风控
    let cleaned = cleanupDom(
      (await (execFileAsync(chrome, args, execOpts) as Promise<{ stdout: string; stderr: string }>)).stdout
    );
    if (!cleaned) {
      await new Promise((r) => setTimeout(r, 5000));
      const retry = await (execFileAsync(chrome, args, execOpts) as Promise<{ stdout: string; stderr: string }>);
      cleaned = cleanupDom(retry.stdout);
    }
    if (!cleaned) return { raw: "", error: "浏览器抓取为空（页面未渲染回答，可能是限流/需登录）" };
    if (JUNK_MARKERS.some((m) => cleaned.includes(m))) {
      return { raw: "", error: "页面未渲染出回答（抓到的是站点外壳/引导文案，浏览器源对本站点不稳定，可改用手动源）" };
    }
    return { raw: cleaned.slice(0, 8000) };
  } catch (e) {
    return { raw: "", error: `浏览器自动化失败: ${(e as Error).message.slice(0, 200)}` };
  }
}

/* ---------- 手动（粘贴 AI 回答到 data/manual/{providerId}-{questionId}.txt） ---------- */

function queryManual(provider: Provider, question: Question): QueryResult {
  const file = path.resolve(process.cwd(), "data/manual", `${provider.id}-${question.id}.txt`);
  if (!existsSync(file)) {
    return { raw: "", error: `手动回答待补充：把 ${provider.label} 对「${question.text}」的回答粘贴到 ${file} 后重跑` };
  }
  return { raw: readFileSync(file, "utf-8").trim() };
}
