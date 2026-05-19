# Fundamental Analysis — Data, Metrics & Flags

> **Source files:** [`ingest/fundamentals.py`](../ingest/fundamentals.py) · [`analysis/fundamental.py`](../analysis/fundamental.py)

---

## What is fetched

All data comes from screener.in HTML pages (consolidated first, standalone as fallback):

```
Primary:  https://www.screener.in/company/{NSE_CODE}/consolidated/
Fallback: https://www.screener.in/company/{NSE_CODE}/
```

Raw HTML is cached in Supabase Storage (`raw-cache` bucket) by SHA-256. If the page hasn't changed, the cached copy is reused.

---

## Annual P&L — FY24, FY25, FY26

Parsed from `<section id="profit-loss">`. Columns mapped from "Mar YYYY" headers.

| Field | screener.in row label | Stored as |
|---|---|---|
| Revenue | "Sales" or "Revenue" | `fundamentals.revenue` (INR Cr) |
| EBITDA / Financing margin | "OPM %" → "Operating Profit %" → "Financing Margin %" → "NIM %" (first match) | `fundamentals.ebitda_margin` (%) |
| Net profit | "Net Profit" | `fundamentals.net_profit` (INR Cr) |

**Fetch-once:** If all three FY rows already exist in the DB, the screener.in HTML fetch is skipped. The 12-month PE is still refreshed via the chart API on every run.

**Banking/NBFC stocks** — screener.in does not show OPM%; the parser falls through to "Financing Margin %" or NIM % automatically. The dashboard label switches to "Financing Margin" when `stock.sector` matches bank/finance/NBFC/insurance.

---

## Quarterly results — FY25, FY26, FY27

Parsed from `<section id="quarters">`. Targets three fiscal years: current FY, and two prior.

| screener.in column | Fiscal year | Quarter |
|---|---|---|
| Jun YYYY | FY(YYYY+1) | Q1 |
| Sep YYYY | FY(YYYY+1) | Q2 |
| Dec YYYY | FY(YYYY+1) | Q3 |
| Mar YYYY | FY(YYYY) | Q4 |

Stored in `quarterly_results (stock_id, fiscal_year, quarter, revenue, net_profit, is_pending)`.

If a quarter's end date has passed but screener.in shows no data, the row is stored with `is_pending = true` and re-fetched on the next run.

**FY26 annual revenue on the dashboard is only shown when Q4 FY26 is confirmed** (`is_pending = false`, `revenue IS NOT NULL`). If Q4 results haven't been filed yet, the column shows "Awaited".

---

## 12-month PE

Fetched from screener.in chart API on every run:

```
GET https://www.screener.in/api/company/{company_id}/chart/?q=PE&days=400
```

The value in the PE series closest to `now − 365 days` is stored as `fundamentals.pe_12m`.

---

## Sector / industry PE

Preferred source: Groww.in `/technicals` page (`stockData.stats.industryPe`), fetched as part of `ingest/prices.py`. Stored in `daily_quotes.sector_pe`. NSEIndia `pdSectorPe` is used as fallback.

---

## Promoter holding

Parsed from `<section id="shareholding">` — "Promoters" row, latest column. Stored in `fundamentals.promoter_pct`.

---

## Flag rules (feed into verdict score)

### Positive flags (+1 each)

| Flag | Condition |
|---|---|
| `STRONG_REVENUE_GROWTH` | Revenue CAGR ≥ 20% |
| `STRONG_PROFIT_GROWTH` | Net profit CAGR ≥ 20% |
| `PE_DISCOUNT` | Stock PE ≤ 0.70 × industry PE |
| `PROMOTER_BUYING` | Promoter holding rose ≥ 2% |

### Negative flags (−1 each)

| Flag | Condition |
|---|---|
| `REVENUE_DECLINE` | Revenue CAGR < 0% |
| `PE_PREMIUM` | Stock PE ≥ 1.30 × industry PE |
| `PROMOTER_SELLING` | Promoter holding dropped ≥ 2% |

---

## Storage schema

```sql
-- Annual fundamentals (fetch-once per FY)
fundamentals (stock_id, period, revenue, net_profit, ebitda_margin, pe_12m, promoter_pct)
-- period: "FY24", "FY25", "FY26"

-- Quarterly results (fetch-once per quarter, re-fetched if is_pending)
quarterly_results (stock_id, fiscal_year, quarter, revenue, net_profit, is_pending)
-- fiscal_year: "FY25", "FY26"; quarter: "Q1"–"Q4"

-- Flags (upserted per run_date)
fundamental_flags (stock_id, run_date, flag, rationale)
```
