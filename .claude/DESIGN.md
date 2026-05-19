# Indian Stock Analyzer — Design Document

> A token-efficient tracking and analysis tool for a fixed watchlist of ~100 Indian (NSE/BSE) stocks. Refreshed every 15 days. Built end-to-end with Claude Code. Surfaced as a local Streamlit dashboard.

---

## 1. Goals & Scope

The tool must do four things per stock in the watchlist:

1. **Track fundamentals** — last 3 years of revenue and net profit growth, PE vs sector PE, promoter holding trend, and other ratios available on screener.in / NSE.
2. **Analyse latest quarterly results & concall** — extract forward guidance on revenue, margin, and net profit. Classify each stock as **High / Medium / Low growth potential**.
3. **Track macro signals** — RBI policy, budget, sector news, commodity moves — and emit green/red flags by sector that fan out to relevant stocks.
4. **Generate technical entry/exit signals** — using deterministic rules over price + volume (50/200 DMA crossover, volume spikes vs 20-day average, RSI, breakout rules).

**Constraints**

- 100 stocks, refreshed once every 15 days.
- Free data sources only.
- Output is a **local Streamlit dashboard**.
- Built end-to-end with **Claude Code**.
- **Minimise token usage / web fetches / re-analysis** — this is the primary engineering constraint.

---

## 2. Core Optimisation Principle

The data has three very different refresh frequencies. The pipeline is structured around **cadence**, not around stocks, so that nothing gets re-analysed when its inputs are unchanged.

| Tier | Data | Cadence | Re-analyse when |
|---|---|---|---|
| Slow | 3-yr revenue/profit, PE, promoter % | Quarterly | Results-day only |
| Daily | Prices, volume, DMA, RSI | Each 15-day run | Always (cheap, deterministic) |
| Event | Concall transcripts | When a new PDF is filed | New file hash |
| Macro | RBI / MoSPI / NSE circulars | Each run | Per event, **once** — fan out to all stocks via sector mapping |

The two specific levers that make this cheap:

1. **Hash-based raw cache.** Every downloaded HTML/PDF/JSON is stored at `cache/raw/<sha256>.ext`. A re-fetch with unchanged content is a no-op.
2. **Hash-keyed analysis cache.** Claude's output is stored at `cache/analysis/<sha256(input)>.json`. If the input hasn't changed, the cached output is replayed — no API call.

After the first run, a 15-day refresh typically only spends Claude tokens on the genuinely new stuff: new concall PDFs and new macro events. An "RBI hikes rates" analysis costs **one** Claude call, not 100 — it's joined to the watchlist via `sector`.

---

## 3. Architecture

```
                            ┌─────────────────────────────────────────────────────┐
                            │ 1 · DATA SOURCES  (split by how often they change)   │
                            └─────────────────────────────────────────────────────┘

  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
  │ Slow / quarterly │   │ Daily prices+vol │   │ Event · concall  │   │ Macro · sector   │
  │ screener.in      │   │ yfinance + NSE   │   │ BSE corp announ. │   │ RBI / MoSPI RSS  │
  │ 3yr rev, PE, ... │   │ bhavcopy CSV     │   │ PDFs & PPTs      │   │ analysed ONCE,   │
  │ refresh: results │   │ refresh: each run│   │ refresh: new file│   │ fan out by sector│
  └────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘
           │                      │                      │                      │
           ▼                      ▼                      ▼                      ▼
  ┌─────────────────────────────────────────────────────────────────────────────────────┐
  │ 2 · CACHE & STORAGE                                                                  │
  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
  │  │ cache/raw/   │  │ stocks.db    │  │cache/analysis│  │ runs.log     │              │
  │  │ sha256.ext   │  │ SQLite, the  │  │ Claude output│  │ what changed │              │
  │  │ HTML·PDF·JSON│  │ source of    │  │ keyed by     │  │ tokens used  │              │
  │  │              │  │ truth        │  │ hash(input)  │  │              │              │
  │  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘              │
  └─────────────────────────────────────────┬───────────────────────────────────────────┘
                                            ▼
  ┌─────────────────────────────────────────────────────────────────────────────────────┐
  │ 3 · ANALYSIS                                                                         │
  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
  │  │ Technical    │  │ Fundamental  │  │ Concall LLM  │  │ Macro LLM    │              │
  │  │ pure Python  │  │ pure Python  │  │ Claude reads │  │ 1 call per   │              │
  │  │ 50/200 DMA   │  │ CAGR, PE vs  │  │ new PDFs →   │  │ event, sector│              │
  │  │ vol spike    │  │ sector PE,   │  │ JSON guide   │  │ → red/green  │              │
  │  │ RSI, rules   │  │ promoter Δ   │  │ skip on hash │  │ fan-out      │              │
  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
  └─────────┼─────────────────┼─────────────────┼─────────────────┼──────────────────────┘
            └─────────────────┴────────┬────────┴─────────────────┘
                                       ▼
  ┌─────────────────────────────────────────────────────────────────────────────────────┐
  │ 4 · SCORING                                                                          │
  │   Verdict synthesiser — weighted rules merge: fundamentals + concall + macro +       │
  │   technical → H / M / L growth label + entry / exit / hold signal                    │
  └─────────────────────────────────────────┬───────────────────────────────────────────┘
                                            ▼
  ┌─────────────────────────────────────────────────────────────────────────────────────┐
  │ 5 · STREAMLIT DASHBOARD                                                              │
  │   Watchlist table │ Per-stock detail │ Macro panel │ Run log (tokens, cache hits)    │
  └─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Data Sources (Free Only)

| Need | Source | Notes |
|---|---|---|
| Daily OHLCV + volume | `yfinance` with NSE tickers (`RELIANCE.NS`, `INFY.NS`) | Cleanest free option; covers everything needed for 50/200 DMA |
| Bhavcopy CSV (optional backup) | `https://www.nseindia.com/...` daily CSV | Useful if yfinance is rate-limited |
| 3-yr financials, PE, promoter % | `screener.in` scrape | Set a sane User-Agent; page structure is stable; cache aggressively |
| Sector PE | `screener.in` sector pages, or NSE sectoral indices | Static enough to cache for a quarter |
| Concall transcripts & PPTs | BSE corporate announcements (`bseindia.com/corporates/ann.html`) | Poll per stock per 15 days; download PDFs |
| Macro — RBI policy | RBI press releases RSS | Cheap text |
| Macro — economy | MoSPI releases | Cheap text |
| Macro — markets | NSE circulars RSS | Cheap text |

Avoid any source requiring login or that disallows scraping in its ToS.

---

## 5. Where Claude is Actually Called

Only two places, both gated by content-hash caches:

1. **Concall analyser** — reads a new transcript PDF, returns strict JSON: revenue guidance, margin guidance, capex, key risks, management tone.
2. **Macro analyser** — reads a single macro event, returns a sector → impact map (red / green / neutral with a one-line rationale).

Everything else is deterministic Python:

- DMA crossovers, volume momentum, RSI, breakout rules.
- Revenue / profit CAGR, PE vs sector PE, promoter holding delta.
- The final H/M/L verdict — a weighted rule, not an LLM call. Keeping the verdict deterministic makes runs reproducible and auditable.

**Expected cost per 15-day run after the first:** roughly *(new transcripts in window) + (macro events in window)* Claude calls. For 100 stocks that's usually 5–20 calls, not 100+.

---

## 6. Repo Layout

```
stock-analyzer/
├── config/
│   └── watchlist.yaml              # 100 stocks: nse_code, bse_code, sector, name
├── ingest/
│   ├── fundamentals.py             # screener.in scraper
│   ├── prices.py                   # yfinance
│   ├── concalls.py                 # BSE corp announcements PDF fetcher
│   └── macro.py                    # RSS readers
├── storage/
│   ├── db.py                       # SQLite schema + accessors
│   └── cache.py                    # hash-keyed raw + analysis caches
├── analysis/
│   ├── technical.py                # DMA, volume, RSI — pure Python
│   ├── fundamental.py              # CAGR, PE-vs-sector, promoter delta
│   ├── concall_llm.py              # Claude call, gated by hash
│   ├── macro_llm.py                # Claude call, one per event
│   └── score.py                    # Weighted verdict synthesiser
├── dashboard/
│   └── app.py                      # Streamlit
├── prompts/
│   ├── concall.md                  # versioned prompt for concall LLM
│   └── macro.md                    # versioned prompt for macro LLM
├── runs/                           # per-run logs + token usage
├── run.py                          # idempotent orchestrator
└── DESIGN.md                       # this document
```

`run.py` is idempotent: running it twice in a row should be ~free on the second run because every cache hits.

---

## 7. SQLite Schema (sketch)

```sql
-- the watchlist itself
stocks(id PK, nse_code, bse_code, name, sector, market_cap_bucket)

-- daily / refresh-time facts
prices(stock_id, date, open, high, low, close, adj_close, volume)
technical_signals(stock_id, run_date, dma_50, dma_200, rsi_14, vol_z20, signal)

-- quarterly facts
fundamentals(stock_id, period, revenue, net_profit, pe, sector_pe, promoter_pct)
fundamental_flags(stock_id, run_date, flag, rationale)

-- concall outputs (one row per filing)
concalls(stock_id, filing_date, source_url, content_hash, json_analysis)

-- macro outputs (one row per event, joined to stocks via sector)
macro_events(id, event_date, source_url, content_hash, json_analysis)
macro_event_impacts(event_id, sector, impact, rationale)

-- the synthesised verdict
verdicts(stock_id, run_date, growth_label, entry_exit, score, components_json)

-- bookkeeping
runs(id, started_at, finished_at, tokens_used, cache_hit_rate, notes)
```

---

## 8. Phased Build Plan

Build in this order so each phase is independently testable. Each phase ends with a runnable CLI you can verify before moving on.

**Phase 1 — Foundations + Technicals (zero Claude calls).**
`config/watchlist.yaml` with 5 sample stocks. SQLite schema. `ingest/prices.py` with yfinance. `analysis/technical.py` with 50/200 DMA, 20-day volume spike, RSI. CLI: `python run.py --phase technical`.

**Phase 2 — Fundamentals (zero Claude calls).**
`ingest/fundamentals.py` scrapes screener.in. `analysis/fundamental.py` computes CAGR, PE-vs-sector, promoter delta, emits red/green flags. CLI: `python run.py --phase fundamental`.

**Phase 3 — Concall LLM (first Claude calls).**
`ingest/concalls.py` polls BSE for new filings, downloads PDFs, stores raw. `analysis/concall_llm.py` calls Claude **only if the file hash is new**, returns strict JSON, caches the output. CLI: `python run.py --phase concall`.

**Phase 4 — Macro LLM (one call per event).**
`ingest/macro.py` reads RBI / MoSPI / NSE RSS. `analysis/macro_llm.py` analyses each new event once and writes a sector-impact map. Join to stocks via `watchlist.sector`. CLI: `python run.py --phase macro`.

**Phase 5 — Verdict synthesiser.**
`analysis/score.py` merges all four signals into H/M/L + entry/exit using a weighted rule. Deterministic, auditable, fast.

**Phase 6 — Dashboard.**
Streamlit app reading exclusively from SQLite. Pages: watchlist table, per-stock detail, macro panel, run log with token usage and cache hit-rate.

**Phase 7 — Expand the watchlist to 100 stocks** once everything is stable.

---

## 9. Starter Prompt for Claude Code

```
Build phase 1 of the stock analyzer in ~/projects/stock-analyzer/ per
DESIGN.md. Create:

- config/watchlist.yaml with 5 sample large-cap Indian stocks
  (RELIANCE, INFY, HDFCBANK, TCS, ITC) including nse_code,
  bse_code, name, sector.
- storage/db.py with the SQLite schema from section 7 (only the
  tables needed for phase 1: stocks, prices, technical_signals, runs).
- ingest/prices.py using yfinance to fetch 2 years of daily OHLCV
  for each stock and upsert into prices.
- analysis/technical.py computing 50-day SMA, 200-day SMA,
  RSI(14), and a 20-day volume z-score; emit a signal
  (entry / exit / hold) using golden-cross / death-cross + volume
  spike rules.
- run.py with a --phase technical mode that runs ingest then analysis
  and prints the signals as a table.

No Claude API calls in this phase. Use uv or pip-tools for deps.
End with a working `python run.py --phase technical`.
```

---

## 10. Things to Watch Out For

- **screener.in rate limiting** — add a 1–2s delay between requests, cache aggressively, and never re-scrape if the raw cache has today's copy.
- **yfinance occasional gaps** — keep bhavcopy as a fallback.
- **PDF extraction quality** — concall PDFs are usually text-based, but some are scanned. Use `pdfplumber` first, fall back to OCR (`pytesseract`) only when needed.
- **Prompt drift** — version `prompts/concall.md` and `prompts/macro.md` in git. If you change the prompt, also bump a `PROMPT_VERSION` constant; the analysis-cache key should include it so old outputs are invalidated.
- **Auditability** — the verdict is deterministic by design. Always persist the `components_json` so you can explain *why* a stock got labelled H/M/L.
