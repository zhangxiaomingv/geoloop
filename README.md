# GEOloopOS · GEO 优化操作系统

**Open-source AI identity engine — measure and grow how AI search engines know, describe, and recommend you.**

让 AI **认识你、理解你、推荐你**。企业 / 个人在 AI 搜索时代的数字身份基础设施。

[![CI](https://github.com/zhangxiaomingv/geoloopos/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangxiaomingv/geoloopos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## What is GEOloopOS?

GEOloopOS is a **Generative Engine Optimization (GEO)** tool. It asks AI search
engines and LLMs — currently **DeepSeek** and **豆包 (Doubao)** — what they know
about a brand, a person, or a website, then scores that answer on a **0–100
visibility scale** across three dimensions:

| Dimension | Weight | Meaning |
|---|---|---|
| **Recognition** | 40 | Does the AI mention the entity at all? (认知) |
| **Description depth** | 30 | How complete is the AI's description? (描述深度) |
| **Source citation** | 30 | Does the AI cite a traceable source? (来源引用) |

You paste a **brand name**, a **website domain**, or any **question** — GEOloopOS
auto-classifies it, generates the right questions, queries both AI engines in
parallel, and returns a report with a score, a verdict, and concrete
optimization tips. It also **tracks the same entity over time**, accumulating a
cognition curve that shows whether your AI visibility is actually improving.

**Who it's for**: companies and individuals who want to be found, described, and
recommended by AI — the channel people increasingly use to make decisions
(which restaurant, which contractor, which SaaS tool, which advisor).

Built by [张可能 / Kene Zhang](https://zkoner.com), GEOloopOS founder and AI
consultant. Product site: **https://zkoner.com**.

---

## Features

| Capability | What it does |
|---|---|
| **3-input auto-classify** | Brand name / website domain / free question — detected automatically, correct questions generated |
| **Dual AI engine** | DeepSeek + Doubao answered in parallel via API — fast, stable, public-friendly (no crawler/browser) |
| **3-dimension scoring** | Recognition 40 + Description 30 + Source 30 = 0–100, with verdict + optimization tips |
| **Positioning anchor** | Fill in name/positioning/keywords/site once → auto-generates 3 unified bio versions (long/mid/short) to paste across platforms + a site-byline snippet — consistency enforced at generation |
| **Article monitoring** | Track your articles → ask AI per topic → judge if your article is cited / site mentioned / content adopted — the ROI of content production |
| **Domain tracking** | Add a domain → re-test AI cognition & citation periodically → trend line over time |
| **Competitor comparison** | Your brand vs competitors, same-口径 detection → ranking, gap score, insight (who leads and why) |
| **Scene intelligence** | Input a real user question (e.g. "深圳推荐一家装修公司") → exposure share per brand + 0-exposure root cause analysis |
| **Unified entity archive** | Every check/re-test/competitor run lands in one entity profile (`data/entities.json`) — the cognition time-series foundation for an "enterprise AI cognition map" |
| **Auto re-test** | Scheduled re-measurement of archived entities → cognition change curves accumulate automatically (the moat: data, not code) |
| **Private deployment** | Single Node process, zero runtime dependencies, Docker one-command deploy, IP rate limiting |

---

## How the scoring works

```
Recognition 40 + Description 30 + Source 30 = 0–100
```

| Score | Verdict |
|---|---|
| ≥ 80 | AI 认知清晰 (clearly recognized) |
| ≥ 60 | AI 有基础认知 (basic recognition) |
| ≥ 40 | AI 认知模糊 (fuzzy recognition) |
| < 40 | AI 尚未认知 (not yet recognized) |

Refusal is detected only for **short** answers (< 80 chars) with explicit
refusal phrasing — "cannot/无法" inside a normal long answer is never miscounted.

### Input classification

- **Brand** (e.g. `海底捞`) → asks "「海底捞」是什么？" and "提供哪些产品或服务？"
- **Website** (e.g. `example.com`) → asks "「example.com」是什么网站？", plus checks whether the answer cites that domain
- **Question** (e.g. `什么是 GEO？`) → asks it verbatim, scores answer quality, extracts mentioned brands/domains

---

## Quick start

```bash
npm install
cp .env.example .env      # fill DEEPSEEK_API_KEY and ARK_API_KEY (see "Model sources")
npm run serve             # start the product server
```

Open `http://localhost:8788`, type a brand / domain / question, hit **检测**.

Re-test all archived entities without calling any API:

```bash
npm run retest -- --dry
```

---

## API (REST, zero-dependency server)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/check` | POST | body `{"query":"..."}` → run one check, persist history, return full report |
| `/api/checks?limit=N` | GET | recent check history (default 20, max 50), newest first |
| `/api/anchor` | GET / POST | positioning anchor + generated versions + platform list + site byline |
| `/api/articles` | GET / POST | article library list / add `{"title","url","topic"}` |
| `/api/articles/:id` | DELETE | remove an article |
| `/api/articles/check` | POST | run article monitoring for all articles (serial, ~15–40 s each) |
| `/api/compare` | POST | body `{"self":"我的品牌","competitors":["竞品1"]}` → comparison ranking + gap + insight |
| `/api/cites` | GET / POST / DELETE | domain tracking list / add / remove |
| `/api/cites/check` | POST | re-test all tracked domains |
| `/api/entities` | GET | full unified entity archive |
| `/api/entities/stats` | GET | archive stats (counts, check totals, scene shares, top scores) |

Example — run a check:

```bash
curl -s -X POST localhost:8788/api/check \
  -H 'Content-Type: application/json' \
  -d '{"query":"海底捞"}'
# → { "ok": true, "report": { "type": "brand", "score": 70, "verdict": "AI 有基础认知", ... } }
```

> Public-facing deployment is rate limited per IP (default 8/min, 80/day) with a
> global concurrency cap (3) and input length validation. See `DEPLOY.md`.

---

## Data model — the cognition archive

Every measurement lands in one normalized entity profile. This time-series is the
project's core asset (the "enterprise AI cognition map" foundation).

```ts
EntityProfile {
  key: string;            // normalized: lowercase, no protocol/www/whitespace
  name: string;
  kind: "brand" | "site";
  industry?: string;      // set by industry checks
  keywords: string[];
  createdAt: string;
  checks:     { at, score, verdict, mention, cited, sources }[];  // cognition curve
  citations:  { at, source, kind }[];                             // who cited you
  sceneShares:{ at, scene, share, rank, total }[];                // exposure per scene
}
```

Archived in `data/entities.json` (gitignored — runtime data stays on the deploy
host; the repo contains code, not customer data).

---

## Auto re-test — the cognition curve loop

```bash
npm run retest                    # re-measure all archived brand/site entities
scripts/install-retest-cron.sh    # install weekly cron (Sun 03:30), flock-guarded
```

Each run appends a new snapshot to every entity's `checks` series and writes a
batch log to `data/retest-log.jsonl`. This powers the monthly **AI cognition
scorecard** workflow: re-test → update scorecard → publish → let AI discover the
change → re-test again. The moat is the accumulated **data**, not the tool code.

---

## Directory layout

```
config.ts           Provider config (DeepSeek / Doubao)
src/check.ts        Detection engine: classify → questions → scoring → report
src/entity.ts       Unified entity archive: normalization + cognition time-series
src/retest.ts       Auto re-test: re-measure archived entities, accumulate curves
src/history.ts      Check history (data/checks.jsonl, zero-dep JSONL)
src/anchor.ts       Positioning anchor: version generation + site byline
src/articles.ts     Article monitoring: library + citation judgment
src/cite.ts         Domain tracking: re-test trends
src/compare.ts      Competitor comparison: ranking + exposure share + insights
src/server.ts       Product API server (rate limit / concurrency / validation)
src/providers.ts    API query layer (DeepSeek / Doubao, retry + timeout)
src/web/            Product front-end (single index.html)
data/               Runtime data (gitignored): checks, entities, anchors, articles, cites
```

---

## Model sources

| Source | Type | Requires |
|---|---|---|
| `deepseek` | OpenAI-compatible API | `DEEPSEEK_API_KEY` (platform.deepseek.com) |
| `doubao` (豆包) | Volcano Ark API | `ARK_API_KEY` (console.volcengine.com/ark) |

Doubao model defaults to `doubao-seed-2-0-pro-260215`, overridable via
`DOUBAO_MODEL`. API keys live only in the server `.env` — page users need no
configuration.

---

## Deployment

```bash
bash deploy.sh                 # auto-detects Docker/Node, asks for keys, one-command start
# or Docker:
docker compose up -d --build   # bind-mounts ./data → data continuity & transparent backup
```

Production notes: reverse proxy (Nginx/Caddy) for HTTPS + real-IP passthrough;
process guard via `docker compose` (`restart: unless-stopped`); single Node
process, lightweight enough for any VPS. Tuning via `RATE_PER_MIN`,
`RATE_PER_DAY`, `MAX_CONCURRENT`. Full details in `DEPLOY.md`.

---

## FAQ

**Q: Is GEO the same as SEO?**
A: No. SEO optimizes for search-engine *results pages*; GEO (Generative Engine
Optimization) optimizes for how AI *answers* — what it mentions, how it
describes, and whether it cites a source. GEOloopOS measures the latter. / GEO
针对 AI 如何「回答」，SEO 针对搜索引擎的「结果页」。GEOloopOS 测的是前者。

**Q: Which AI engines does it check?**
A: DeepSeek and Doubao (both OpenAI-compatible). Adding a source is a one-entry
config change in `config.ts`. / 当前 DeepSeek + 豆包，可扩展。

**Q: Does it need my API key as a user?**
A: No — keys live on the server. You only type a brand / domain / question. /
使用者无需配置任何 key。

**Q: What does a score of 0 mean?**
A: The AI gave no substantive answer (refusal) or did not mention the entity —
typically because there is no crawlable, consistent public content about it.
Optimization tips in the report address this directly.

**Q: Can I use it for my competitors?**
A: Yes. `/api/compare` runs the same detection on your brand + competitors and
shows ranking, gap, and who leads — and why.

**Q: Where does the data go?**
A: All runtime data stays on your host in `data/` (gitignored). The repo
contains code, not customer or brand data.

**Q: Is it free / self-hostable?**
A: MIT-licensed and self-hostable with one Docker command. You only pay the two
AI engines' API usage.

---

## Roadmap & docs

- `ROADMAP.md` — P0 auto re-test + industry templates; P1 public HTTPS/domain,
  industry benchmarks, brand/domain mapping; P2 accounts, AI cognition map, AI
  cognition reports.
- `IDENTITY-ENGINE.md` — product positioning & the "AI identity engine" concept.
- `VISION.md` — moat strategy (data assets > tool code).
- `DEPLOY.md` — deployment & operations.
- `AIAGENTS.md` — architecture & data-model guide for AI agents working in the repo.

---

## Author & license

Built by **张可能 / Kene Zhang** — AI consultant, GEO engineer, GEOloopOS founder.
Site: **https://zkoner.com** · GitHub: [zhangxiaomingv](https://github.com/zhangxiaomingv)

Released under the **MIT License**. If you use or build on GEOloopOS, a citation
(`CITATION.cff`) is appreciated.

**GEOloopOS · GEO 优化操作系统** — 让 AI 认识你、理解你、推荐你。
