-- Phase 6: replace raw OHLCV with structured market data
-- Adds daily_quotes and quarterly_results; extends fundamentals

-- ── fundamentals: new columns ────────────────────────────────────────────────
alter table fundamentals add column if not exists ebitda_margin numeric;  -- OPM %
alter table fundamentals add column if not exists pe_12m        numeric;  -- PE 12 months ago

-- ── daily_quotes: CMP, market cap, DMA, volume (refreshed every run) ─────────
create table if not exists daily_quotes (
    id              bigserial primary key,
    stock_id        bigint not null references stocks(id) on delete cascade,
    date            date not null,
    cmp             numeric,            -- last traded price (NSEIndia)
    pct_change      numeric,            -- % change vs previous close
    market_cap_cr   numeric,            -- total market cap in INR crores
    week_52_high    numeric,            -- 52-week high
    week_52_low     numeric,            -- 52-week low
    pe              numeric,            -- current trailing PE (NSEIndia)
    sector_pe       numeric,            -- sector/industry PE (NSEIndia)
    volume_today    bigint,             -- shares traded today
    dma_50          numeric,            -- 50-day moving avg (screener.in)
    dma_200         numeric,            -- 200-day moving avg (screener.in)
    avg_volume_30d  numeric,            -- 30-trading-day avg daily volume
    volume_7d       jsonb,              -- last 7 trading days: [{date, volume}, ...]
    unique(stock_id, date)
);
create index if not exists daily_quotes_stock_date on daily_quotes(stock_id, date desc);

alter table daily_quotes enable row level security;
create policy "public read daily_quotes" on daily_quotes for select using (true);

-- ── quarterly_results: Q1-Q4 per FY ─────────────────────────────────────────
create table if not exists quarterly_results (
    id          bigserial primary key,
    stock_id    bigint not null references stocks(id) on delete cascade,
    fiscal_year text not null,      -- "FY26"
    quarter     text not null,      -- "Q1" | "Q2" | "Q3" | "Q4"
    revenue     numeric,            -- INR crores; null = NR
    net_profit  numeric,            -- INR crores; null = NR
    is_pending  boolean default false,  -- true when results not yet published
    unique(stock_id, fiscal_year, quarter)
);

alter table quarterly_results enable row level security;
create policy "public read quarterly_results" on quarterly_results for select using (true);
