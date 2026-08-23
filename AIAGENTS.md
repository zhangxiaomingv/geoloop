# GEOloopOS — Guide for AI Agents

Context for AI coding agents working in this repository. Read this before making
changes. Humans: see `CONTRIBUTING.md` and `README.md`.

## What this project is

**GEOloopOS** ("AI 可见度基础设施") is an open-source **AI identity engine**. It
measures how AI search engines and LLMs — currently **DeepSeek** and **豆包
(Doubao)** — recognize, describe, and recommend a brand, a person, or a website,
then scores that visibility on a 0–100 scale. The long-term asset is the **data**:
a per-entity cognition time-series (`data/entities.json`) that grows into an
"enterprise AI cognition map".

Created by 张晓明 / Xiaoming Zhang, GEOloopOS founder. Product site: https://zkoner.com.

## Runtime facts

- **ESM** (`"type": "module"`), TypeScript with NodeNext. Import local modules
  with `.js` extensions (`import { runCheck } from "./check.js"`).
- **Zero-dependency philosophy**: runtime uses only Node built-ins + `dotenv`.
  `tsx` runs TS directly in dev/container. No test framework — verification is
  `tsc --noEmit` + manual smoke.
- Run: `npm run serve` (dev), `npm run retest -- --dry` (re-test dry-run),
  `docker compose up -d --build` (deploy). API keys in `.env`
  (`DEEPSEEK_API_KEY`, `ARK_API_KEY`).
- Port `8788`. Rate limit: 8/min & 80/day per IP, max 3 concurrent checks.

## Architecture map

```
config.ts           Provider config (DeepSeek / Doubao, OpenAI-compatible)
src/check.ts        Detection engine — input classify → questions → scoring → report
src/providers.ts    API query layer (fetch, 1 retry, 120s timeout)
src/entity.ts       Unified entity archive — the cognition time-series store
src/retest.ts       Auto re-test — re-measures archived entities (curve accumulation)
src/history.ts      Check history — append-only JSONL (data/checks.jsonl)
src/anchor.ts       Positioning anchor — unified intro versions + site snippet
src/articles.ts     Article monitoring — are your articles adopted by AI answers
src/cite.ts         Domain tracking — citation trend lines
src/compare.ts      Competitor comparison — rankings, scene share, gap insights
src/server.ts       Zero-dep HTTP API (rate limit / concurrency / validation)
src/web/index.html  Single-file product front-end (fetch → server API)
data/               Runtime data (gitignored): checks.jsonl, entities.json, ...
```

## Input classification & scoring (the core logic)

`classify(query)` in `src/check.ts`:
- contains a domain → **site** mode (asks "what is X", checks the answer *cites that domain*)
- ends with a question word → **question** mode (no entity, scores answer quality)
- otherwise → **brand** mode (asks "what is X", "what does X offer")

`scoreAnswer()` → `认知 40 + 描述 30 + 来源 30 = 0-100`. Refusal detection requires
a **short** answer (< 80 chars) matching explicit refusal phrasing — long answers
with "cannot/无法" are normal content, never treated as refusal.

## Data model (data/entities.json)

The core asset. Per entity archive:

```ts
EntityProfile {
  key: string;            // normalized: lowercase, no protocol/www/whitespace
  name: string;
  kind: "brand" | "site";
  industry?: string;      // set by industry checks
  keywords: string[];
  site?: string;
  createdAt: string;
  checks:   CheckSnapshot[];   // time-series: at, score, verdict, mention, cited, sources
  citations: CitationRef[];    // which AI source cited the entity
  sceneShares: SceneShare[];   // exposure share per scene question
}
```

Convention: **every detection / re-test / competitor check lands into one entity
archive** via `attachCheck` / `attachSceneShares` / `attachCiteCitation`. This is
the "enterprise AI cognition map" data foundation. Never break this funnel.

## Conventions

- Keep the entity funnel intact — anything that measures a brand must write back
  to `entities.json`.
- Don't commit `data/` runtime files (gitignored). Commit schema/doc examples only.
- New AI sources: add a `Provider` in `config.ts` (OpenAI-compatible). Browser/
  manual providers exist in `src/providers.ts` but the product uses API sources.
- README stays an **AI-extractable fact card** (English-first, Chinese inline).
- Commit messages: small, atomic, prefixed (`feat:` `fix:` `docs:`).

## Verification before pushing

```bash
npx tsc --noEmit          # must pass
npm run retest -- --dry   # optional: confirm entity targeting logic
```

Report faithfully: if an API call failed or a test was skipped, say so.
