-- Phase 5: verdicts

create table if not exists verdicts (
    id              bigserial primary key,
    stock_id        bigint not null references stocks(id) on delete cascade,
    run_date        date not null,
    growth_label    text,       -- H / M / L
    entry_exit      text,       -- entry / exit / hold
    score           numeric,
    components_json jsonb,      -- full breakdown for auditability
    unique(stock_id, run_date)
);

alter table verdicts enable row level security;
create policy "public read verdicts" on verdicts for select using (true);
