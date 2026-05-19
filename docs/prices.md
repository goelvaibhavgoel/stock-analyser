# Market Data — Sources, Ingestion & Storage

> **Source files:**
> - Daily market data: [`ingest/prices.py`](../ingest/prices.py)
> - Fundamental & quarterly data: [`ingest/fundamentals.py`](../ingest/fundamentals.py)
> - Schema: [`supabase/migrations/0006_market_data.sql`](../supabase/migrations/0006_market_data.sql)

---

## Overview

All market and financial data is sourced from **NSEIndia.com**, **screener.in**, and **groww.in** (industry PE). yfinance is no longer used.

Data is split into two refresh cadences:

| Cadence | Data | Source |
|---|---|---|
| **Every run** | CMP, % change, market cap, PE, 52w high/low, today's volume, DMA-50, DMA-200 | NSEIndia API + screener.in chart API |
| **Every run** | ~7-day avg volume (5-day sum ÷ 5), ~30-day avg volume (25-day sum ÷ 25), vol ratio, industry PE | Groww.in `/technicals` (screener.in volume as fallback for stocks not on Groww) |
| **Once (fetch-once)** | FY24/25/26 revenue, EBITDA/financing margin, net profit; 12m PE; promoter % | screener.in HTML |
| **Once per quarter** | Quarterly revenue & net profit — FY25, FY26, FY27 (re-checked if marked pending) | screener.in HTML |

---

## Data Sources

### NSEIndia.com — real-time quote API

**Endpoint:**
```
GET https://www.nseindia.com/api/quote-equity?symbol={NSE_CODE}
```

NSEIndia's API requires a valid browser session (cookies). A warm-up GET to the homepage is made first to acquire cookies, then the quote API is called.

```python
session = requests.Session()
session.get("https://www.nseindia.com", timeout=15)
# now session has cookies — two calls per stock:
quote = session.get(f"https://www.nseindia.com/api/quote-equity?symbol={nse_code}").json()
# market cap & volume only populated in trade_info section (even after market close)
trade = session.get(f"https://www.nseindia.com/api/quote-equity?symbol={nse_code}&section=trade_info").json()
```

**Fields extracted:**

| Field | JSON path | Stored as |
|---|---|---|
| Current market price | `priceInfo.lastPrice` | `daily_quotes.cmp` |
| % change vs prev close | `priceInfo.pChange` | `daily_quotes.pct_change` |
| Market cap (crores) | `marketDeptOrderBook.tradeInfo.totalMarketCap` (already in crores) | `daily_quotes.market_cap_cr` |
| 52-week high | `priceInfo.weekHighLow.max` | `daily_quotes.week_52_high` |
| 52-week low | `priceInfo.weekHighLow.min` | `daily_quotes.week_52_low` |
| Today's volume | `marketDeptOrderBook.tradeInfo.totalTradedVolume × 1e5` (lakh shares → shares) | `daily_quotes.volume_today` |
| Current PE | `metadata.pdSymbolPe` | `daily_quotes.pe` |
| Sector PE (fallback) | `metadata.pdSectorPe` | `daily_quotes.sector_pe` |

Market cap: NSEIndia `totalMarketCap` is already in crores — no conversion needed.

Volume: NSEIndia `totalTradedVolume` is in lakh shares. Multiply by 1e5 to get absolute share count (consistent with screener.in volume series which uses absolute shares).

---

### screener.in — chart API (DMA + volume)

**Endpoint:**
```
GET https://www.screener.in/api/company/{company_id}/chart/
    ?q=Price-DMA50-DMA200-Volume&days=60
```

The `company_id` is screener.in's internal numeric ID, extracted from the company page HTML:
```python
match = re.search(r'data-company-id=["\'](\d+)["\']', html)
company_id = match.group(1)
```

`days=60` covers ~42 trading days — enough for DMA values (computed server-side from full history) and the 25-day volume window needed for the 30d avg proxy.

**Response format:**
```json
{
  "datasets": [
    {"metric": "DMA50",  "values": [[unix_ms, value], ...]},
    {"metric": "DMA200", "values": [[unix_ms, value], ...]},
    {"metric": "Volume", "values": [[unix_ms, volume], ...]}
  ]
}
```

**Fields extracted (DMA only — volume is now from Groww.in):**

| Field | How derived | Stored as |
|---|---|---|
| DMA-50 | Latest non-null value in `DMA50` series | `daily_quotes.dma_50` |
| DMA-200 | Latest non-null value in `DMA200` series | `daily_quotes.dma_200` |

The `Volume` series from the chart API is retained as a **fallback** for stocks without a Groww slug (currently EPACKPEB and EFCIL). When used as fallback:

| Field | How derived | Stored as |
|---|---|---|
| Last 5 trading days volume | Last 5 non-null entries in `Volume` series | `daily_quotes.volume_7d` (JSONB) |
| ~30-day avg volume | Sum of last 25 non-null volume entries ÷ 25 | `daily_quotes.avg_volume_30d` |

`volume_7d` is stored as a JSONB array:
```json
[
  {"date": "2026-05-09", "volume": 234567},
  {"date": "2026-05-12", "volume": 198234},
  ...
]
```

---

### screener.in — HTML page (static fundamentals)

**URL:**
```
Primary:  https://www.screener.in/company/{NSE_CODE}/consolidated/
Fallback: https://www.screener.in/company/{NSE_CODE}/
```

The consolidated page is tried first (for holding companies and conglomerates). If it returns 404, the standalone page is used.

**Raw HTML is cached** in Supabase Storage (`raw-cache` bucket) by SHA-256 of the response bytes. If the page hasn't changed since the last fetch, the cached copy is reused — no network call.

#### Annual P&L — FY24, FY25, FY26

Parsed from `<section id="profit-loss">`. Three fields per fiscal year:

| Field | Screener row label | Stored as |
|---|---|---|
| Revenue | "Sales" or "Revenue" | `fundamentals.revenue` (INR Cr) |
| EBITDA / Financing margin | "OPM %" → "Operating Profit %" → "Financing Margin %" → "Net Interest Margin" → "NIM %" (first match) | `fundamentals.ebitda_margin` (%) |
| Net profit | "Net Profit" | `fundamentals.net_profit` (INR Cr) |

For banking/NBFC companies screener.in does not show OPM%; the parser falls through to "Financing Margin %" or NIM automatically. The dashboard label switches to "Financing Margin" when `stock.sector` matches bank/finance/NBFC/insurance.

Column headers are in "Mar YYYY" format. Mapping:
```
"Mar 2024" → FY24
"Mar 2025" → FY25
"Mar 2026" → FY26
```

#### Quarterly results — 3 fiscal years

Parsed from `<section id="quarters">`. Column headers like "Jun 2025", "Sep 2025" are mapped to fiscal year and quarter. Three FYs are targeted: `fy_now`, `fy_now-1`, `fy_now-2` — so in FY2027 context, FY25/FY26/FY27 are all captured. The dashboard displays FY25 and FY26.

| screener.in label | Fiscal year | Quarter |
|---|---|---|
| Jun YYYY | FY(YYYY+1) | Q1 |
| Sep YYYY | FY(YYYY+1) | Q2 |
| Dec YYYY | FY(YYYY+1) | Q3 |
| Mar YYYY | FY(YYYY) | Q4 |

Example: "Jun 2025" → Q1 FY26, "Mar 2025" → Q4 FY25.

If a quarter's end date has passed but screener.in shows no data (results not yet filed), the row is stored with `is_pending = true` and displayed as **Awaited** in the dashboard. On the next pipeline run, pending quarters are re-fetched.

#### Ratios — sector PE, promoter holding

| Field | Source |
|---|---|
| Sector/industry PE | Groww.in `/technicals` page `stockData.stats.industryPe` (preferred); NSEIndia `pdSectorPe` (fallback) |
| Promoter holding % | `<section id="shareholding">` table, "Promoters" row, latest column |

---

### Groww.in — volume + industry P/E (preferred source)

**Endpoint:**
```
GET https://groww.in/stocks/{groww_slug}/technicals
```

`groww_slug` is a stock-specific identifier stored in `config/watchlist.yaml` (e.g. `zaggle-prepaid-ocean-services-ltd`). Stocks not listed on Groww (EPACKPEB, EFCIL) have no slug and fall back to the screener.in volume data.

The page is server-side rendered (Next.js). All data is embedded in the `__NEXT_DATA__` JSON blob in the HTML:
```python
m = re.search(r'id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
page_data = json.loads(m.group(1))
pp = page_data["props"]["pageProps"]
```

**Fields extracted:**

| Field | Source in `pageProps` | How derived | Stored as |
|---|---|---|---|
| ~7-day avg volume proxy | `stocksVolumeStatsData.data` | Last 5 entries `totalVolume` (list) | `daily_quotes.volume_7d` (JSONB) |
| ~30-day avg volume proxy | `liveCandles` (daily OHLCV since IPO) | Sum of last 25 `volume` values ÷ 25 | `daily_quotes.avg_volume_30d` |
| Industry PE | `stockData.stats.industryPe` or `.sectorPe` | Direct value | `daily_quotes.sector_pe` (overrides NSEIndia) |

**Volume ratio methodology:**
- `volume_7d` stores the last 5 trading days of total traded volume; the frontend sums them and divides by 5 as a proxy for the 7-day average.
- `avg_volume_30d` is the sum of the last 25 daily candle volumes ÷ 25 as a proxy for the 30-day average.
- `vol_ratio = avg(volume_7d) / avg_volume_30d` — a value > 1.3 indicates above-average recent volume.

If the Groww fetch fails or no slug is configured, the values written by screener.in remain unchanged.

---

### screener.in — chart API (PE history)

**Endpoint:**
```
GET https://www.screener.in/api/company/{company_id}/chart/?q=PE&days=400
```

`days=400` covers 13+ months — enough to find the PE value from exactly 12 months ago.

**Fields extracted:**

| Field | How derived | Stored as |
|---|---|---|
| 12m PE | Value in PE series closest to `now − 365 days` | `fundamentals.pe_12m` |

The 12m PE is updated on every pipeline run (it changes as the stock's price changes).

---

## Fetch-once logic

Annual fundamentals are expensive to scrape and don't change once a fiscal year is complete. The pipeline checks the DB before hitting the network:

```python
def _annual_needs_fetch(stock_id):
    existing = db.table("fundamentals").select("period")
               .eq("stock_id", stock_id)
               .in_("period", ["FY24","FY25","FY26"])
               .execute().data
    found = {r["period"] for r in existing}
    return not {"FY24","FY25","FY26"}.issubset(found)
```

If all three FY rows exist → skip the screener.in HTML fetch entirely. The 12m PE is still refreshed via the chart API.

For quarterly results, each quarter is checked individually:
- Not in DB → fetch
- `is_pending = true` → re-fetch (results may now be published)
- `is_pending = false` with data → skip

---

## Storage schema

### `daily_quotes` table (refreshed every run)

```sql
create table daily_quotes (
    id              bigserial primary key,
    stock_id        bigint not null references stocks(id) on delete cascade,
    date            date not null,
    cmp             numeric,            -- last traded price (NSEIndia)
    pct_change      numeric,            -- % change vs previous close
    market_cap_cr   numeric,            -- total market cap in INR crores
    week_52_high    numeric,
    week_52_low     numeric,
    pe              numeric,            -- current trailing PE (NSEIndia)
    sector_pe       numeric,            -- sector/industry PE (NSEIndia)
    volume_today    bigint,             -- shares traded today
    dma_50          numeric,            -- 50-day moving avg (screener.in)
    dma_200         numeric,            -- 200-day moving avg (screener.in)
    avg_volume_30d  numeric,            -- sum(last 25 trading days) ÷ 20  (30d avg proxy)
    volume_7d       jsonb,              -- [{date, volume}, ...] last 5 trading days (7d avg proxy)
    unique(stock_id, date)
);
```

### `fundamentals` table (fetch-once per FY)

```sql
-- existing table, extended with:
alter table fundamentals add column ebitda_margin numeric;  -- OPM %
alter table fundamentals add column pe_12m        numeric;  -- PE 12 months ago
```

One row per `(stock_id, period)` where period is "FY24", "FY25", or "FY26".

### `quarterly_results` table (fetch-once per quarter)

```sql
create table quarterly_results (
    id          bigserial primary key,
    stock_id    bigint not null references stocks(id) on delete cascade,
    fiscal_year text not null,      -- "FY26"
    quarter     text not null,      -- "Q1" | "Q2" | "Q3" | "Q4"
    revenue     numeric,            -- INR crores; null = not yet available
    net_profit  numeric,            -- INR crores; null = not yet available
    is_pending  boolean default false,
    unique(stock_id, fiscal_year, quarter)
);
```

---

## Technical signal generation

`analysis/technical.py` now reads from `daily_quotes` instead of computing from raw OHLCV history.

**Golden/death cross detection** uses the two most recent `daily_quotes` rows:
```python
today = daily_quotes[-1]   # current DMA-50, DMA-200
prev  = daily_quotes[-2]   # previous run's DMA values

golden = (prev.dma_50 <= prev.dma_200) and (today.dma_50 > today.dma_200)
death  = (prev.dma_50 >= prev.dma_200) and (today.dma_50 < today.dma_200)
```

**Volume ratio** replaces the old z-score:
```
volume_ratio = volume_today / avg_volume_30d
```

Signal rules:
- Golden cross + `volume_ratio > 1.3` → `entry`
- Death cross → `exit`
- `dma_50 > dma_200` + `volume_ratio > 2.0` → `entry` (strong uptrend with spike)
- Default → `hold`

RSI is no longer computed (no raw OHLCV data available).

---

## What is no longer used

| Removed | Reason |
|---|---|
| `yfinance` | Replaced by NSEIndia + screener.in |
| Raw OHLCV `prices` table | Not needed — DMA values come pre-computed from screener.in |
| RSI-14 computation | Requires raw daily price series; not available from new sources |
| `vol_z20` (z-score) | Replaced by `volume_ratio` (today ÷ 30d avg); stored in same DB column |

---

## Limitations & known gaps

| Gap | Impact | Future fix |
|---|---|---|
| NSEIndia API requires session cookies | Occasional 401/403 if session expires mid-run | Retry with fresh session on auth failure |
| screener.in company ID may not be in HTML for some stocks | DMA/volume unavailable | Fallback: search screener.in by name |
| Volume avg uses 5-day / 25-day windows | Proxies, not exact 7d/30d averages | Approach specified by product design |
| 12m PE re-fetched every run | Minor extra API call | Cache with 7-day TTL |
| PE and market cap are NSEIndia EOD values | May lag during live session | Accept EOD values — pipeline is not intraday |
| Quarterly "NR" rows re-fetched on every run | Extra screener.in HTML fetch for stocks with pending quarters | Stop re-checking after 90 days post quarter-end |
