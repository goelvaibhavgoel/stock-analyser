-- Phase 3: concalls and analysis_cache

create table if not exists concalls (
    id              bigserial primary key,
    stock_id        bigint not null references stocks(id) on delete cascade,
    filing_date     date not null,
    source_url      text,
    content_hash    text unique,
    storage_path    text,
    json_analysis   jsonb,
    analysed_at     timestamptz
);

-- Generic analysis cache keyed by sha256(input)
create table if not exists analysis_cache (
    id              bigserial primary key,
    input_hash      text unique not null,
    output_json     jsonb not null,
    prompt_version  text not null,
    created_at      timestamptz default now()
);

alter table concalls enable row level security;
alter table analysis_cache enable row level security;

create policy "public read concalls"        on concalls        for select using (true);
create policy "public read analysis_cache"  on analysis_cache  for select using (true);
