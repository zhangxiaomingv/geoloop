# AI 爬虫观测 · AI Crawler Observatory（功能方案）

> 状态：🔲 待开发 · 设计定稿 2026-08-19
> 差异化判断：海外（Profound/Cloudflare/Scrunch）都在做 GPTBot/ClaudeBot 观测，**中国 AI 爬虫的观测是空档**——本功能主攻中国引擎（豆包/元宝/Kimi/文心/DeepSeek），兼覆盖海外。

## 一、为什么做

「问 AI 认不认识你」是**输出端**检测；但 AI 不认识你的根因常在**输入端**——爬虫根本没读到你的内容。本功能把输入端变成可观测：

- 你被哪些 AI 爬虫访问过（字节 Bytespider / 百度 Baiduspider / 月之暗面 KimiBot…）
- 它们有没有被挡住（403/444/robots 拦截）——直击用户踩过的 Cloudflare robots 坑
- 它们读了哪些页面（= AI 实际吃进去的内容，即「引用候选」）
- 输出端检测（你已有的）＋输入端观测（本功能）= GEO 完整闭环

**技术点**：纯读服务端日志（nginx/Cloudflare Logpush），无 JS 埋点、无 API 成本、不碰用户前端。

## 二、模块设计

### 1. `src/crawlers.ts` — AI 爬虫知识库（数据驱动，可扩展）

```ts
type CrawlerKind = "training" | "search" | "user" | "policy"; // 训练 / 检索 / 用户触发 / 政策标记
interface CrawlerInfo {
  id: string;              // "bytespider"
  label: string;           // "字节·豆包"
  org: string;             // "ByteDance"
  origin: "cn" | "intl";   // 中国 / 海外
  kind: CrawlerKind;
  uaPatterns: string[];    // UA 模糊匹配词，如 ["Bytespider"]
  robotsName: string;      // robots.txt 里对应的 User-agent 名
  note?: string;
}
function classifyCrawler(ua: string): CrawlerInfo | null; // 全小写后 indexOf 匹配
```

**初始清单**（2026-08 核实，各家 UA 可随 `crawlers-data` 扩展）：

| id | label | origin | kind | 匹配词（UA 含） |
|---|---|---|---|---|
| bytespider | 字节·豆包 | cn | training | `Bytespider`（多 UA 变体，附 `spider-feedback@bytedance.com`） |
| kimibot | 月之暗面 Kimi | cn | training | `KimiBot` |
| kimi-searchbot | Kimi 搜索索引 | cn | search | `Kimi-SearchBot` |
| kimi-user | Kimi 用户触发 | cn | user | `Kimi-User` |
| qwenbot | 阿里·通义 | cn | training | `QwenBot`（⚠️ 官方无文档，民间 UA，需 IP 交叉验证） |
| tongyibot | 阿里·通义助手 | cn | search | `TongyiBot` |
| aliyunbot | 阿里云 | cn | search | `AliyunBot` |
| baiduspider | 百度（含文心联网） | cn | search | `Baiduspider` |
| deepseekbot | DeepSeek | cn | training | `DeepSeekBot` |
| 360spider | 360·纳米搜索 | cn | search | `360Spider` |
| petalbot | 华为花瓣 | cn | search | `PetalBot` |
| sogou | 搜狗（腾讯） | cn | search | `Sogou` |
| gptbot | OpenAI 训练 | intl | training | `GPTBot` |
| oai-searchbot | OpenAI 检索 | intl | search | `OAI-SearchBot` |
| chatgpt-user | OpenAI 浏览 | intl | user | `ChatGPT-User` |
| claudebot | Anthropic 训练 | intl | training | `ClaudeBot`（旧 `anthropic-ai` 归并） |
| claude-searchbot | Claude 检索（2026 新增） | intl | search | `Claude-SearchBot` |
| claude-user | Claude 用户触发 | intl | user | `Claude-User` |
| googlebot | Google 主抓取 | intl | search | `Googlebot`（AI Overviews 走它，勿挡） |
| google-extended | Google 政策标记 | intl | policy | 无 UA（仅 robots 审计用） |
| perplexitybot | Perplexity 索引 | intl | search | `PerplexityBot` |
| meta-externalagent | Meta AI | intl | training | `Meta-ExternalAgent` |
| amazonbot | Amazon | intl | training | `Amazonbot` |
| applebot | Apple Siri | intl | search | `Applebot` |
| ccbot | Common Crawl | intl | training | `CCBot` |
| bingbot | Bing/Copilot | intl | search | `Bingbot` |
| youbot | You.com | intl | search | `YouBot` |

> 已知盲区：**腾讯元宝无独立爬虫 UA**（主要走搜狗/Bingbot），需日志长期观测补全；**UA 可伪造**——「IP 校验」列为 P2 企业版能力。

### 2. `src/logparse.ts` — 日志解析（流式，大文件友好）

支持三种来源：
- **nginx access log**（combined 格式，`$remote_addr - - [$time] "METHOD $path" $status $bytes "$referer" "$ua"`，中国站点默认形态）
- **Cloudflare Logpush JSON**（每行一个 JSON 对象）
- **原始文本上传/粘贴**（服务端 5MB 上限）

统一产出 `LogLine { at, ip, method, path, status, bytes, ua }`。

### 3. `src/crawlerlog.ts` — 分析引擎

输入：日志文件/目录（限 `CRAWLER_LOG_DIR` 配置目录内）+ 日期范围 + 域名过滤。

输出报告：

```ts
interface CrawlerReport {
  at: string;
  source: string;
  windowDays: number;
  totalAiHits: number;
  blockedHits: number;              // 403/444/robots 拦截
  crawlers: {
    id: string; label: string; origin: "cn"|"intl"; kind: CrawlerKind;
    hits: number; uniqueUrls: number; blocked: number;
    statusDist: Record<number, number>;
    topPages: { path: string; hits: number }[];   // 它读了什么 = 引用候选
  }[];
  topCrawledPages: { path: string; crawlers: string[]; hits: number }[];
  trend: CrawlerSnapshot[];         // 历史时序列
}
```

**核心洞察输出**：
- 「AI 爬虫被挡」告警（blockedHits > 0 且命中训练类爬虫 → 你的内容进不了语料）
- 最常被抓的页面 = AI 实际读到的内容 = 引用归因的候选（与输出端 citations 对接）
- 中国/海外爬虫覆盖对比

**隐私**：只落聚合，不落原始日志行；IP 匿名化（保留前 3 段或直接丢弃）。

### 4. `src/robots.ts` — AI robots 审计（小、独立、先做）

输入域名 → 抓 `robots.txt` → 逐 AI 爬虫判 allow/block/未声明。**关键智慧**：区分 training vs search——推荐策略「挡训练爬虫、放检索爬虫」（Block GPTBot 不影响 OAI-SearchBot；放 Googlebot 不放 Google-Extended）。同时检查 policy-only token（Google-Extended/Applebot-Extended 不出现在日志，但影响训练用途）。

→ 直接命中用户踩过的 Cloudflare robots 坑，可作为**免费审计钩子**（无需日志即可用）。

### 5. API（`server.ts` 新增，复用限流+并发闸）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/crawlers/bots` | GET | 知识库清单（前端展示/编辑用） |
| `/api/crawlers/analyze` | POST | body `{source:"upload"|"path", text?, path?}` → 分析报告；文件读取仅限 `CRAWLER_LOG_DIR` |
| `/api/crawlers/report` | GET | 最近报告 + 趋势快照 |
| `/api/audit/robots` | GET | `?domain=` → AI robots 指令审计（免费钩子） |

安全：上传 ≤5MB、`path` 白名单目录、IP 限流复用 `allow()`。

### 6. 前端（`index.html` 加「AI 爬虫观测」区）

三来源 tab（上传 / 粘贴 / 日志目录）→ 爬虫卡片（标签：中/海外 + kind）+ 展开「它读了哪些页面」+ 被挡告警条 + robots 审计表 + 趋势。

### 7. 数据模型

`data/crawler-runs.json`：每次分析快照（聚合），跨期积累「AI 抓取量」时序列 —— 与 `entities.json` 认知曲线并列的第二条数据资产线。

## 三、落地顺序

1. **P0.5 · robots 审计**（`robots.ts` + `/api/audit/robots` + 前端小卡片）——独立、1 天、直接命中 Cloudflare 坑、可马上给客户演示
2. **P1 · 知识库 + 解析**（`crawlers.ts` + `logparse.ts`）
3. **P1 · 分析引擎 + API + UI**（`crawlerlog.ts`）
4. **P2 · 增强**：IP 交叉验证（防伪造）、Cloudflare Logpush/S3 云日志接入、与输出端 citations 对接（被读页面 → 引用归因）

## 四、与 ROADMAP 关系

「AI 就绪度审计」方向（借鉴 Scrunch/Rankscale/Botify 的 AI Readiness），本方案是其中国化落地形态。建议并入 ROADMAP P1。

## 参考

- UA 知识库基准：[henu-wang/ai-crawlers-reference](https://github.com/henu-wang/ai-crawlers-reference)、[Honeyb 2026 UA 参考](https://www.honeyb.ai/blog/ai-crawler-user-agents-reference-2026)、[Rankly Agent Directory](https://www.tryrankly.com/agent-directory/bytespider)
- 「training vs search 三分法」：[dev.to robots.txt 2026 cheat sheet](https://dev.to/brandswarm/robotstxt-for-ai-search-the-2026-cheat-sheet-gptbot-claudebot-and-the-rest-16a)
