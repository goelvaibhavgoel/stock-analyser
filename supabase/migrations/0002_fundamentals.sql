-- Phase 2: fundamentals and fundamental_flags

create table if not exists fundamentals (
    id              bigserial primary key,
    stock_id        bigint not null references stocks(id) on delete cascade,
    period          text not null,       -- e.g. "FY2024", "FY2023"
    revenue         numeric,
    net_profit      numeric,
    pe              numeric,
    sector_pe       numeric,
    promoter_pct    numeric,
    unique(stock_id, period)
);

create table if not exists fundamental_flags (
    id          bigserial primary key,
    stock_id    bigint not null references stocks(id) on delete cascade,
    run_date    date not null,
    flag        text not null,    -- e.g. STRONG_GROWTH, PE_PREMIUM, PROMOTER_SELLING
    rationale   text,
    unique(stock_id, run_date, flag)
);

alter table fundamentals enable row level security;
alter table fundamental_flags enable row level security;

create policy "public read fundamentals"       on fundamentals       for select using (true);
create policy "public read fundamental_flags"  on fundamental_flags  for select using (true);
