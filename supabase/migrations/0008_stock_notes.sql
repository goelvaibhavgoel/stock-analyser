-- Phase 8: stock_notes — per-stock user notes

create table if not exists stock_notes (
    nse_code   text primary key,
    note       text not null default '',
    updated_at timestamptz default now()
);

alter table stock_notes disable row level security;
