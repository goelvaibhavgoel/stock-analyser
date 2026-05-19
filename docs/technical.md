# Technical Analysis — Indicators & Signal Rules

> **Source file:** [`analysis/technical.py`](../analysis/technical.py)
> **Data source:** [`daily_quotes`](../supabase/migrations/) table (written by `ingest/prices.py`)

---

## Overview

Technical analysis reads pre-computed values from the `daily_quotes` table — it does not compute indicators from raw OHLCV history.

| Indicator | Source | Stored in |
|---|---|---|
| DMA-50 | screener.in chart API (server-computed) | `daily_quotes.dma_50` |
| DMA-200 | screener.in chart API (server-computed) | `daily_quotes.dma_200` |
| Volume ratio | Groww.in `/technicals` page | `daily_quotes.volume_today` ÷ `avg_volume_30d` |

RSI is no longer computed (requires raw OHLCV, which is not stored).

---

## Volume ratio

```
vol_ratio = volume_today / avg_volume_30d
```

- `volume_today` — shares traded today (from NSEIndia)
- `avg_volume_30d` — sum of last 25 daily candle volumes ÷ 25 (from Groww.in; screener.in fallback for stocks without a Groww slug)

A ratio > 1.0 means today's volume is above the 30-day baseline.

---

## Signal rules

The two most recent `daily_quotes` rows are compared to detect crossovers.

| Rule | Condition | Signal |
|---|---|---|
| Golden cross + volume | `prev_dma50 ≤ prev_dma200` AND `dma50 > dma200` AND `vol_ratio > 1.3` | `entry` |
| Death cross | `prev_dma50 ≥ prev_dma200` AND `dma50 < dma200` | `exit` |
| Strong uptrend + spike | `dma50 > dma200` AND `vol_ratio > 2.0` | `entry` |
| Everything else | — | `hold` |

Rules are evaluated in order; first match wins.

---

## Stored output

One row per `(stock_id, run_date)` in `technical_signals`:

| Column | Value |
|---|---|
| `dma_50` | DMA-50 value from `daily_quotes` |
| `dma_200` | DMA-200 value from `daily_quotes` |
| `rsi_14` | Always `null` (no longer computed) |
| `vol_z20` | Volume ratio (column repurposed — stores ratio, not z-score) |
| `signal` | `entry` / `exit` / `hold` |

---

## Contribution to verdict score

```
entry → +2
hold  →  0
exit  → -2
```

---

## Known gaps

| Gap | Impact |
|---|---|
| No RSI | Overbought entries not filtered |
| DMA values are pipeline-cadence, not intraday | Cross detection is run-to-run, not tick-level |
| Volume ratio uses screener.in fallback (25-day window) for EPACKPEB, EFCIL | Slightly different methodology vs Groww stocks |
