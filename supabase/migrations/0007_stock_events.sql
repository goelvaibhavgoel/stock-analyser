-- Phase 7: stock_events — per-stock corporate filings and news events

create table if not exists stock_events (
    id            bigserial primary key,
    stock_id      bigint not null references stocks(id) on delete cascade,
    event_date    date not null,
    raw_title     text,                   -- original RSS/news title, fed to LLM
    event_summary text,                   -- 50-70 char LLM-produced summary
    source_name   text,                   -- "NSE Filing", "MoneyControl", "CNBC TV18"
    source_link   text,                   -- URL or PDF link
    impact        text,                   -- GOOD / BAD / NO_IMPACT
    content_hash  text not null,
    json_analysis jsonb,
    analysed_at   timestamptz,
    unique(stock_id, content_hash)
);

create index if not exists stock_events_stock_date on stock_events(stock_id, event_date desc);
create index if not exists stock_events_date on stock_events(event_date desc);

alter table stock_events enable row level security;
create policy "public read stock_events" on stock_events for select using (true);
