-- Phase 1: stocks, prices, technical_signals, runs

create table if not exists stocks (
    id              bigserial primary key,
    nse_code        text unique not null,
    bse_code        text,
    name            text not null,
    sector          text not null,
    market_cap_bucket text,
    created_at      timestamptz default now()
);

create table if not exists prices (
    id          bigserial primary key,
    stock_id    bigint not null references stocks(id) on delete cascade,
    date        date not null,
    open        numeric,
    high        numeric,
    low         numeric,
    close       numeric,
    adj_close   numeric,
    volume      bigint,
    unique(stock_id, date)
);
create index if not exists prices_stock_date on prices(stock_id, date desc);

create table if not exists technical_signals (
    id          bigserial primary key,
    stock_id    bigint not null references stocks(id) on delete cascade,
    run_date    date not null,
    dma_50      numeric,
    dma_200     numeric,
    rsi_14      numeric,
    vol_z20     numeric,
    signal      text,    -- entry / exit / hold
    unique(stock_id, run_date)
);

create table if not exists runs (
    id              bigserial primary key,
    started_at      timestamptz not null default now(),
    finished_at     timestamptz,
    tokens_used     integer default 0,
    cache_hit_rate  numeric,
    notes           text,
    status          text default 'running'   -- running / success / failed
);

-- RLS: allow public read-only access (dashboard uses anon key)
alter table stocks enable row level security;
alter table prices enable row level security;
alter table technical_signals enable row level security;
alter table runs enable row level security;

create policy "public read stocks"              on stocks              for select using (true);
create policy "public read prices"              on prices              for select using (true);
create policy "public read technical_signals"   on technical_signals   for select using (true);
create policy "public read runs"                on runs                for select using (true);
