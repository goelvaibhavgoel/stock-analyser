-- Phase 4: macro_events and macro_event_impacts

create table if not exists macro_events (
    id              bigserial primary key,
    event_date      date not null,
    source_url      text,
    title           text,
    content_hash    text unique,
    json_analysis   jsonb,
    analysed_at     timestamptz
);

create table if not exists macro_event_impacts (
    id          bigserial primary key,
    event_id    bigint not null references macro_events(id) on delete cascade,
    sector      text not null,
    impact      text not null,   -- GREEN / RED / NEUTRAL
    rationale   text,
    unique(event_id, sector)
);

alter table macro_events enable row level security;
alter table macro_event_impacts enable row level security;

create policy "public read macro_events"         on macro_events         for select using (true);
create policy "public read macro_event_impacts"  on macro_event_impacts  for select using (true);
