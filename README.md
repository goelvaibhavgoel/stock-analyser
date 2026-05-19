# Indian Stock Analyser

A pipeline that tracks 14 NSE stocks, fetches market data daily, and serves a live Next.js dashboard.

---

## What it does

| Phase | What happens |
|---|---|
| **prices** | Fetches CMP, PE, market cap, DMA-50/200, volume from NSEIndia + screener.in + Groww.in |
| **fundamental** | Scrapes screener.in for annual P&L, EBITDA margin, quarterly results, 12m PE, promoter holding |
| **concall** | Polls BSE announcements, downloads new PDFs, calls OpenAI to extract guidance |
| **score** | Merges technical signal + fundamental flags + concall tone → H / M / L verdict per stock |
| **dashboard** | Next.js app reads Supabase, shows watchlist + per-stock detail pages |

---

## Architecture

```
python run.py --phase <phase>
  ├── ingest/prices.py       → NSEIndia API + screener.in chart API + Groww.in /technicals
  ├── ingest/fundamentals.py → screener.in HTML (annual P&L, quarterly results, 12m PE)
  ├── ingest/concalls.py     → BSE PDF → Supabase Storage → OpenAI
  ├── analysis/technical.py  → DMA cross + volume ratio → entry/exit/hold
  ├── analysis/fundamental.py→ CAGR + PE flags + promoter flags
  ├── analysis/concall_llm.py→ OpenAI gpt-4o-mini (hash-gated)
  └── analysis/score.py      → deterministic weighted verdict
        ↓ writes to
  Supabase (Postgres)
        ↓ read by
  Next.js dashboard (Vercel)
```

---

## Repo layout

```
stock-analyser/
├── config/
│   └── watchlist.yaml              # 14 stocks: nse_code, bse_code, sector, groww_slug
├── ingest/
│   ├── prices.py                   # daily market data → daily_quotes table
│   ├── fundamentals.py             # screener.in → fundamentals + quarterly_results
│   └── concalls.py                 # BSE PDF fetcher + storage
├── storage/
│   ├── db.py                       # Supabase client + helpers
│   └── cache.py                    # SHA-256 raw HTML cache
├── analysis/
│   ├── technical.py                # DMA cross, volume ratio, signal rules
│   ├── fundamental.py              # CAGR, PE vs sector PE, promoter delta
│   ├── concall_llm.py              # OpenAI call, hash-gated cache
│   └── score.py                    # Weighted verdict synthesiser
├── dashboard/                      # Next.js 14 app
│   └── app/
│       ├── page.tsx                # Watchlist table (sticky header, all metrics)
│       └── stock/[nse_code]/       # Per-stock detail page
├── prompts/
│   └── concall.md                  # Versioned LLM prompt
├── supabase/migrations/            # SQL files — run once in Supabase SQL editor
├── run.py                          # Orchestrator — --phase and --limit flags
└── pyproject.toml                  # uv-managed Python deps
```

---

## Setup

### 1. Supabase

1. Create a free project at [supabase.com](https://supabase.com)
2. **SQL Editor** → run each migration file in order
3. **Storage** → create a private bucket: `raw-cache`

### 2. Environment variables

```bash
cp .env.example .env
# Fill in:
# SUPABASE_URL
# SUPABASE_SERVICE_KEY
# OPENAI_API_KEY
# NEXT_PUBLIC_SUPABASE_URL
# NEXT_PUBLIC_SUPABASE_ANON_KEY
```

### 3. Python pipeline

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
uv sync

python run.py --phase prices        # market data
python run.py --phase technical     # signals
python run.py --phase fundamental   # screener.in financials
python run.py --phase concall       # BSE PDFs + OpenAI
python run.py --phase score         # verdict table

# or all at once:
python run.py --phase all

# limit stocks during dev:
python run.py --phase all --limit 5
```

### 4. Dashboard (local)

```bash
cd dashboard
npm install
cp ../.env .env.local
npm run dev    # http://localhost:3000
```

### 5. Deploy to Vercel

1. Push repo to GitHub
2. Vercel → import repo → set Root Directory to `dashboard`
3. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` env vars
4. Deploy

---

## Data sources

| Data | Source | Cadence |
|---|---|---|
| CMP, PE, market cap, 52w high/low, today's volume | NSEIndia API | Every run |
| DMA-50, DMA-200 | screener.in chart API | Every run |
| ~7d avg volume, ~30d avg volume, industry PE | Groww.in `/technicals` page | Every run (stocks with `groww_slug`) |
| Annual P&L (revenue, EBITDA margin, net profit) | screener.in HTML | Fetch-once per FY |
| Quarterly revenue & net profit | screener.in HTML | Fetch-once per quarter |
| 12-month PE history | screener.in chart API | Every run |
| Concall transcripts / PDFs | BSE corporate announcements | New PDFs only |

All sources are free. No login required.

---

## Scoring formula

```
score = technical + fundamental + concall

technical:   entry=+2,  hold=0,  exit=-2
fundamental: +1 per positive flag (STRONG_REVENUE_GROWTH, STRONG_PROFIT_GROWTH, PE_DISCOUNT, PROMOTER_BUYING)
             -1 per negative flag (REVENUE_DECLINE, PE_PREMIUM, PROMOTER_SELLING)
concall:     positive=+2,  neutral=0,  negative=-2

label:  score > 3 → H   |   0–3 → M   |   < 0 → L
```

---

## Cost profile

| Item | Cost |
|---|---|
| Supabase | Free tier |
| Vercel | Free hobby tier |
| OpenAI | ~$0.01–0.05 per run (gpt-4o-mini, hash-gated) |
| NSEIndia / screener.in / Groww.in / BSE | Free |

---

## Docs

- [docs/prices.md](docs/prices.md) — Data sources, ingestion logic, storage schema
- [docs/technical.md](docs/technical.md) — DMA signals, volume ratio, signal rules
- [docs/fundamentals.md](docs/fundamentals.md) — Annual P&L, quarterly results, flags
- [docs/concall.md](docs/concall.md) — Concall ingestion, LLM extraction, caching
