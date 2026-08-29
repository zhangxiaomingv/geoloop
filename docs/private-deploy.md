# GEOloopOS 企业私有部署 · 交付方案

> 定位：私有部署 = SaaS 之外的**高价补充线**。客户自己买服务器/内网，我们远程部署交付，数据不出境。
> SaaS 版（激活码订阅）仍是主线。本方案描述私有部署的交付物、架构、配置与边界。

## 1. 交付物清单

| # | 交付物 | 说明 | 状态 |
|---|---|---|---|
| 1 | **Docker 镜像** `geoloopos/identity-engine` | 已含全部代码，`node:20-slim` + VOLUME，零构建依赖 | ✅ 现有 |
| 2 | **客户侧 compose 文件** | 拉镜像直接起，不接触源码 | 📦 本方案新增（deploy/） |
| 3 | **.env.example** | LLM key + 激活码管理口令，模板交付 | 📦 本方案新增 |
| 4 | **备份 / 升级脚本** | data/ 卷 tar 备份、镜像拉取升级 | 📦 本方案新增 |
| 5 | **部署文档**（本文件） | 架构、配置、验收清单 | ✅ 本文件 |
| 6 | 远程部署服务 | 配置、联调、验收 | 人工交付 |

## 2. 部署架构

```
客户内网 / 云服务器
┌────────────────────────────────────────────┐
│  Docker 主机（x86_64 / arm64）              │
│  ┌──────────────────────────────────────┐  │
│  │ geoloopos 容器 :8788                  │  │
│  │  - 代码全内置，无构建依赖              │  │
│  │  - VOLUME /app/data（检测/锚点/引用/  │  │
│  │    知识库/发稿台账）                  │  │
│  │  - 需要出站到 LLM API（客户填 key）    │  │
│  └──────────────────────────────────────┘  │
│        ▲ bind 或 named volume              │
│        └── data/（透明可备份）              │
└────────────────────────────────────────────┘
        │ https
        ▼
  反向代理（Nginx / Caddy / Traefik）
   - 443 终结 TLS，转发 8788
   - 可选内网-only：不暴露公网
```

**外部依赖**：仅 3 个 LLM API（DeepSeek / 豆包 Ark / Perplexity），客户自备 key。系统**无其他出站依赖**（Observe 观测、媒体库都是本地数据）。

## 3. 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Linux（Ubuntu 22.04+/Debian 12+/CentOS 兼容）；Docker Engine 24+ / Docker Compose v2 |
| 架构 | x86_64 或 arm64（node:20-slim 多架构） |
| 资源 | 最低 1C1G，推荐 2C2G（检测是外部 API 调用，本地几乎不吃算力） |
| 网络 | 出站 443 到 LLM API；入站按需（纯内网可不开公网） |
| 时间 | NTP 同步（激活码/session 依赖时钟） |

## 4. 配置（.env）

```bash
# ---- 必填：LLM 检测源（客户自备，至少 1 个）----
DEEPSEEK_API_KEY=
ARK_API_KEY=                # 豆包，可选
OPENROUTER_API_KEY=         # 可选
PPLX_API_KEY=               # Perplexity，可选（带 citations 真引用）

# ---- 控制台付费门禁（激活码）----
LICENSE_ADMIN_KEY=          # 管理激活码用，客户侧交付时由我方设置
OBSERVE_SITES=              # 来访观测站点白名单，默认 zkoner.com,geoloopos.com

# ---- 可选调优 ----
RATE_PER_MIN=8
RATE_PER_DAY=80
MAX_CONCURRENT=3
```

**注意**：`SOFTWEN_*`（软文街发稿）在私有部署里**默认不配**——发稿是我们 SaaS 的执行能力，客户私有部署用我们的发稿 API 是另外的商务约定。

## 5. 数据持久化与备份

- 数据全在 `data/` 卷：`checks.jsonl`（检测历史）、`entities.json`（认知档案）、`anchor.json`、`kb.jsonl`、`cites.json`、`articles.json`、`publish.json`（发稿台账）、`licenses.json`（激活码）、`sessions.json`、`bots.json`
- **备份**：`docker run --rm -v <data卷>:/app/data -v $(pwd):/backup alpine tar czf /backup/geoloopos-data-$(date +%F).tar.gz -C /app/data .`
- **恢复**：解压覆盖 data 卷后重启容器

## 6. 升级

```
docker compose pull        # 拉新镜像（镜像即版本）
docker compose up -d
```

数据卷保留，代码随镜像升级，无迁移动作。

## 7. 激活码分发（私有部署的收费方式）

客户侧部署完成后，我们通过 `LICENSE_ADMIN_KEY` 在**我方侧**生成激活码发给客户，或直接配置到客户 `.env`：
- **年付订阅**：客户内网跑，激活码按年发放（到期后续）
- **永久授权**：一次性部署 + 服务费，激活码永久

两套都支持：`node scripts/gen-license.mjs "客户X" 365`（或省略天数 = 永久）。

## 8. 验收清单（交付时逐项勾）

- [ ] `docker compose up -d` 后 `/` 营销页 200
- [ ] `/app/login` 200，输入激活码进入控制台
- [ ] `/api/check` 真实跑一次检测（≥1 个 LLM key 生效）
- [ ] 数据持久化：重启容器后检测历史仍在
- [ ] 反向代理 HTTPS 正常（如配公网）
- [ ] 备份脚本可跑通并生成 tar

## 9. 交付边界（诚实声明）

**现成（开箱即用）**：
- AI 可见度检测全套（品牌/网站/问句，三引擎实时比对）
- 企业 AI 认知档案库（多实体监测、认知时间序列）
- 知识库 + 知识缺口分析、竞品对比、趋势追踪
- 控制台管理后台（激活码门禁）+ 检测/审计 API

**需定制开发（deploy 页承诺但尚未实现，客户提需求时评估报价）**：
- 「权限体系」：目前只有激活码门禁（单一管理员），**无多用户/角色**。私有部署若要企业内多人分权需定制。
- 「数据导出」：目前无结构化导出接口，需定制。
- 「开放 API」：检测 API 是公开的，但无 API key/配额体系，需定制。
- 「与企业系统对接」（SSO/LDAP/OAuth）：未实现。

> 这三点在 /deploy 页面文案里写的是「部署交付范围」，实际是**路线图项**而非现成能力。**建议**：要么改文案标注「可选定制」，要么等第一个私有部署客户出现时按定制报价。当前先不动页面，避免误导——但方案文档里如实标注。

## 10. 定价建议（商务，非技术）

- SaaS 订阅：￥X/月/工作区（激活码，未定）
- 私有部署：一次性部署费（远程部署 + 验收）+ 年服务费（升级/维护），客单价显著高于 SaaS
- 私有部署**不含**软文发稿执行能力（那是 SaaS 侧的事）

## 相关

- 数据层多租户预留：`src/store.ts`（`dataPath(workspace, file)`）——私有部署单客户用 `default` 工作区即可；若客户要「多团队分区」再启用 workspace
- 控制台付费门禁：`src/license.ts` + `scripts/gen-license.mjs`
