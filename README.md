# GEOloopOS Identity Engine · GEO优化操作系统

> **总定位：企业 / 个人 AI 身份引擎。** 定义你是谁 → 校准 AI 如何认识你 → 传播你的内容 → 赢得场景推荐 → 把 AI 身份沉淀为可追踪、可增长的战略资产。
> 完整定位见 [`IDENTITY-ENGINE.md`](./IDENTITY-ENGINE.md)；护城河战略见 [`VISION.md`](./VISION.md)。

输入品牌名、网站域名或任意问题，同时询问 **DeepSeek** 与 **豆包**，自动评分「AI 眼中的你」：是否认识你、描述多完整、有没有给出来源。产品级通用工具，人人可用，无需配置。

## 快速开始

```bash
npm install
cp .env.example .env      # 填入 DEEPSEEK_API_KEY、ARK_API_KEY（见下表）
npm run serve             # 启动产品服务
```

打开 `http://localhost:8788` —— 在首页输入框键入品牌 / 域名 / 问句，点「检测」即可。

## 产品能力

| 能力 | 说明 |
|---|---|
| **三类输入自动识别** | 品牌名（含域名→网站模式）、网站域名、任意问句，自动分类并生成合适的问题集 |
| **双 AI 源即时检测** | DeepSeek + 豆包 API 并行回答，无需任何爬虫/浏览器（快、稳、公网友好） |
| **三维度评分** | 认知（40）+ 描述深度（30）+ 来源引用（30）= 0-100，输出结论 + 优化建议 |
| **定位锚点** | 填一次名称/定位/关键词/官网 → 自动生成长/中/短三版统一口径简介（知乎/微博/抖音等全平台可复制）+ 站点署名代码片段，一致性靠生成时强制 |
| **文章监测** | 维护文章库（标题/URL/主题）→ 按主题问 AI 推荐 → 判定文章被引用 / 站点被提及 / 内容被采用，回答「内容生产的 ROI」 |
| **域名追踪** | 加入域名 → 周期性复测 AI 认知与引用 → 历史趋势折线（引用追踪子模块） |
| **竞品对比** | 输入自己 + 竞品 → 对每个实体做同口径检测 → 横向排名 + 差距分 + 洞察（谁领先、赢在哪、怎么补） |
| **竞品智能 · 场景认知** | 填用户真实问题（如「深圳推荐一家装修公司」）→ 统计各品牌在 AI 回答中的**曝光份额** + 0 曝光根因（缺案例 / FAQ / 行业实体关系） |
| **统一实体档案** | 每次检测/复测/竞品自动归入品牌实体档案（`data/entities.json`），沉淀认知时间序列 |
| **检测历史** | 每次检测落盘 `data/checks.jsonl`，页面可回看、点击加载 |
| **公网安全** | 按 IP 限流（默认 8 次/分、80 次/天）+ 全局并发上限（3）+ 输入长度校验 |

### 三类输入的检测逻辑

- **品牌**（如 `海底捞`）→ 问「X 是什么？」「X 提供哪些产品或服务？」，判定回答是否提及品牌、描述是否完整、有无来源。
- **网站**（如 `example.com`）→ 问「X 是什么网站？」，额外判定回答是否引用了该域名。
- **问句**（如 `什么是 GEO？`）→ 原样问，按回答质量（描述深度 + 来源）评分，并提取回答中提到的网站/品牌。

### 评分规则

`认知 40 + 描述 30 + 来源 30 = 0-100`：

| 分数 | 结论 |
|---|---|
| ≥ 80 | AI 认知清晰 |
| ≥ 60 | AI 有基础认知 |
| ≥ 40 | AI 认知模糊 |
| < 40 | AI 尚未认知 |

拒绝回答的判定要求**短回答 + 具体拒答措辞**（如「抱歉，我无法回答」），长回答里的「无法/不能」等正常用词不会误伤。

## API（供第三方集成）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/check` | POST | body `{"query":"..."}` → 运行一次检测，落盘历史，返回完整报告 |
| `/api/checks?limit=N` | GET | 最近 N 条检测历史（默认 20，上限 50），新的在前 |
| `/api/anchor` | GET | 定位锚点 + 三版生成 + 平台清单 + 署名代码 |
| `/api/anchor` | POST | body `{"anchor":{...}}` → 保存锚点，返回更新后的版本与代码 |
| `/api/articles` | GET / POST | 文章库列表 / 添加 `{"title","url","topic"}` |
| `/api/articles/:id` | DELETE | 删除文章 |
| `/api/articles/check` | POST | 触发全部文章监测（串行跑，每篇约 15–40 秒） |
| `/api/compare` | POST | body `{"self":"我的品牌","competitors":["竞品1","竞品2"]}` → 竞品对比排名 + 差距 + 洞察 |
| `/api/cites` | GET / POST / DELETE | 域名追踪列表 / 添加 / 删除 |
| `/api/cites/check` | POST | 复测全部追踪域名 |
| `/api/entities` | GET | 统一实体档案全量 |
| `/api/entities/stats` | GET | 档案统计（品牌/域名数、检测次数、场景份额、最高分榜） |

## GEO 认知闭环（推荐工作流）

```
① 定位锚点：填一次「名称/定位/关键词/官网」→ 生成长/中/短三版统一简介 + 站点署名代码
② 各平台统一复制：锚点简介贴到知乎/公众号/微博/小红书/抖音…（口径逐字一致，AI 学到的画像清晰）
③ 站点署名：把署名代码贴进 CMS 模板，以后所有文章自动带 canonical/author/作者卡片
④ 检测：输入品牌名/域名/问句，看 AI 眼中的你（认知/描述/来源三维度 + 分数）
⑤ 文章监测：把常发文章加入监测，看哪些内容被 AI 真正采用（选题 ROI）
⑥ 复测：执行建议后重新检测，看分数爬坡（历史趋势）
```

核心洞察：**AI 品牌认知 = 存在性 × 一致性 × 清晰度 × 权威性**。检测管「存在性」，锚点统一复制管「一致性」，署名/作者卡片管「清晰度」，官网可爬管「权威性」。

## 模型源

| 源 | 方式 | 需要什么 |
|---|---|---|
| `deepseek` | OpenAI 兼容 API | `DEEPSEEK_API_KEY`（platform.deepseek.com） |
| `doubao`（豆包） | 火山方舟 ARK API | `ARK_API_KEY`（console.volcengine.com/ark） |

> 豆包模型名默认 `doubao-seed-2-0-pro-260215`，可用环境变量 `DOUBAO_MODEL` 改为其它已开通模型名或接入点 ID（ep-xxx）。API key 只存在服务端 `.env`，页面用户无需任何配置。

## 部署

### 本机 / 私有化

```bash
bash deploy.sh        # 自动检测 Docker/Node，交互填 Key，一键启动
```

或 Docker：

```bash
cp .env.example .env  # 填入两个 Key
docker compose up -d --build
```

### 公网

服务监听 `0.0.0.0:8788`，端口可用 `PORT` 修改。生产部署建议：

- **反向代理**：Nginx/Caddy 转发 `8788`，配置 HTTPS，同时按 `X-Forwarded-For` 透传真实 IP（服务端已按该头做 IP 限流）。
- **进程守护**：`docker compose`（`restart: unless-stopped`）或 systemd。
- **资源**：单 Node 进程，零外部依赖（除两个 API），轻量可放任意 VPS。

限流阈值环境变量：`RATE_PER_MIN`（默认 8）、`RATE_PER_DAY`（默认 80）、`MAX_CONCURRENT`（默认 3）。

详见 [`DEPLOY.md`](./DEPLOY.md)。

## 目录结构

```
config.ts          模型源配置（DeepSeek / 豆包）
src/check.ts       检测引擎：输入分类 / 问题生成 / 评分 / 报告
src/history.ts     历史存储（data/checks.jsonl，零依赖 JSONL）
src/anchor.ts      定位锚点：统一口径版本生成 + 站点署名代码 + data/anchor.json
src/articles.ts    文章监测：文章库 + 按主题问 AI 推荐 + 引用判定 + data/articles.json
src/cite.ts        域名追踪：复测趋势 + data/cites.json
src/compare.ts     竞品对比 / 竞品智能：排名 + 曝光份额 + 差距洞察
src/entity.ts      统一实体档案：品牌/域名归一 + 认知时间序列 + data/entities.json
src/server.ts      产品 API 服务（限流 / 并发 / 校验）
src/providers.ts   API 查询（DeepSeek / 豆包，含重试与超时）
src/web/           产品前端页（Hero 输入框 + 评分环 + 锚点工作台 + 引用追踪 + 竞品智能 + 历史）
data/              运行时数据（gitignored）：检测历史 / 锚点 / 文章 / 域名 / 实体档案
```

## 路线图

下一阶段规划见 [`ROADMAP.md`](./ROADMAP.md)。
