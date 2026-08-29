# Contributing to GEOloopOS

Thanks for being here. This is a small, focused project — the fastest way to contribute is to open an issue or PR on the right area.

## Ground rules

- **Zero-dependency philosophy**: the runtime uses only Node.js built-ins plus `dotenv`. No framework, no database. Keep it that way unless a dependency is unavoidable.
- **ESM + strict TS**: `.ts` sources import with `../config.js`-style `.js` extensions (NodeNext). Run `npx tsc --noEmit` before pushing.
- **Data lives in `data/`**: runtime data (`checks.jsonl`, `entities.json`, anchors, articles, cites) is gitignored and stays on the deploy host. Never commit real customer/brand data to the public repo.
- **Bilingual docs**: README is the AI-facing fact card (English-first, Chinese inline). Product docs (`IDENTITY-ENGINE.md`, `VISION.md`) stay Chinese. Keep the author line: 张晓明 / GEOloopOS 创始人.

## Get started

```bash
npm install
cp .env.example .env      # fill DEEPSEEK_API_KEY / ARK_API_KEY
npm run serve             # http://localhost:8788
```

## Where things live

| Path | Role |
|---|---|
| `src/check.ts` | Detection engine: input classify → questions → scoring → report |
| `src/entity.ts` | Unified entity archive (`data/entities.json`) — the cognition time-series |
| `src/server.ts` | Zero-dep HTTP API (rate limit / concurrency / validation) |
| `src/providers.ts` | API query layer (DeepSeek / Doubao, retry + timeout) |
| `src/web/` | Product front-end (single `index.html`) |
| `config.ts` | Provider config |

See `AIAGENTS.md` for the full architecture map and data model.

## What's wanted

- Detection / scoring edge cases (refusals, question-mode mention rates, industry checks)
- New industry templates (`src/templates.ts` direction)
- API docs, examples, and integration guides
- Bug reports with the exact query + provider that failed

## Process

1. Fork, branch off `main`, keep commits small and atomic.
2. `npx tsc --noEmit` must pass. Add a one-line `docs:`/`fix:`/`feat:` commit message.
3. Open a PR against `main` describing the change and why it matters for GEO visibility.
