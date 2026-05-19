"""Supabase client singleton and typed upsert/query helpers."""

import os
from functools import lru_cache
from typing import Any

from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()


@lru_cache(maxsize=1)
def get_client() -> Client:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_KEY"]
    return create_client(url, key)


# ---------------------------------------------------------------------------
# stocks
# ---------------------------------------------------------------------------

def upsert_stock(nse_code: str, bse_code: str, name: str, sector: str, market_cap_bucket: str) -> int:
    """Insert or update a stock row; return its id."""
    db = get_client()
    result = (
        db.table("stocks")
        .upsert(
            {
                "nse_code": nse_code,
                "bse_code": bse_code,
                "name": name,
                "sector": sector,
                "market_cap_bucket": market_cap_bucket,
            },
            on_conflict="nse_code",
        )
        .execute()
    )
    return result.data[0]["id"]


def get_stock_id(nse_code: str) -> int | None:
    db = get_client()
    result = db.table("stocks").select("id").eq("nse_code", nse_code).execute()
    return result.data[0]["id"] if result.data else None


def get_all_stocks() -> list[dict]:
    db = get_client()
    return db.table("stocks").select("*").execute().data


def delete_unlisted_stocks(active_nse_codes: list[str]) -> int:
    """Delete stocks not in active_nse_codes. Returns number of rows deleted."""
    db = get_client()
    all_stocks = db.table("stocks").select("id,nse_code").execute().data
    to_delete = [s["id"] for s in all_stocks if s["nse_code"] not in active_nse_codes]
    if not to_delete:
        return 0
    db.table("stocks").delete().in_("id", to_delete).execute()
    return len(to_delete)


# ---------------------------------------------------------------------------
# prices
# ---------------------------------------------------------------------------

def upsert_prices(rows: list[dict]) -> None:
    """Bulk upsert price rows. Each row must have stock_id and date."""
    if not rows:
        return
    db = get_client()
    # upsert in chunks of 500 to stay within Supabase request limits
    for i in range(0, len(rows), 500):
        db.table("prices").upsert(rows[i : i + 500], on_conflict="stock_id,date").execute()


def get_prices(stock_id: int, limit: int = 250) -> list[dict]:
    db = get_client()
    return (
        db.table("prices")
        .select("date,open,high,low,close,adj_close,volume")
        .eq("stock_id", stock_id)
        .order("date", desc=True)
        .limit(limit)
        .execute()
        .data
    )


# ---------------------------------------------------------------------------
# technical_signals
# ---------------------------------------------------------------------------

def upsert_technical_signal(row: dict) -> None:
    db = get_client()
    db.table("technical_signals").upsert(row, on_conflict="stock_id,run_date").execute()


def get_latest_technical_signal(stock_id: int) -> dict | None:
    db = get_client()
    result = (
        db.table("technical_signals")
        .select("*")
        .eq("stock_id", stock_id)
        .order("run_date", desc=True)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


# ---------------------------------------------------------------------------
# runs
# ---------------------------------------------------------------------------

def create_run() -> int:
    db = get_client()
    result = db.table("runs").insert({"status": "running"}).execute()
    return result.data[0]["id"]


def finish_run(run_id: int, tokens_used: int = 0, cache_hit_rate: float = 0.0, notes: str = "", status: str = "success") -> None:
    from datetime import datetime, timezone
    db = get_client()
    db.table("runs").update(
        {
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "tokens_used": tokens_used,
            "cache_hit_rate": round(cache_hit_rate, 4),
            "notes": notes,
            "status": status,
        }
    ).eq("id", run_id).execute()
