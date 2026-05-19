"""Deterministic verdict synthesiser. Merges 4 signal types into H/M/L label."""

import logging
from datetime import date, timedelta

from storage.db import get_client, get_stock_id

log = logging.getLogger(__name__)

MACRO_LOOKBACK_DAYS = 30


def _get_technical(stock_id: int) -> dict | None:
    db = get_client()
    result = (
        db.table("technical_signals")
        .select("signal,dma_50,dma_200,rsi_14,vol_z20")
        .eq("stock_id", stock_id)
        .order("run_date", desc=True)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def _get_fundamental_flags(stock_id: int, run_date: str) -> list[dict]:
    db = get_client()
    return (
        db.table("fundamental_flags")
        .select("flag")
        .eq("stock_id", stock_id)
        .eq("run_date", run_date)
        .execute()
        .data
    )


def _get_latest_concall(stock_id: int) -> dict | None:
    db = get_client()
    result = (
        db.table("concalls")
        .select("json_analysis")
        .eq("stock_id", stock_id)
        .not_.is_("json_analysis", "null")
        .order("filing_date", desc=True)
        .limit(1)
        .execute()
    )
    return result.data[0]["json_analysis"] if result.data else None


def _get_macro_impacts(sector: str) -> list[dict]:
    db = get_client()
    cutoff = (date.today() - timedelta(days=MACRO_LOOKBACK_DAYS)).isoformat()
    # Two-step: get recent event IDs, then fetch impacts for that sector
    events = (
        db.table("macro_events")
        .select("id")
        .gte("event_date", cutoff)
        .execute()
        .data
    )
    if not events:
        return []
    event_ids = [e["id"] for e in events]
    return (
        db.table("macro_event_impacts")
        .select("impact")
        .eq("sector", sector)
        .in_("event_id", event_ids)
        .execute()
        .data
    )


def _score_technical(signal: str | None) -> int:
    return {"entry": 2, "hold": 0, "exit": -2}.get(signal or "hold", 0)


POSITIVE_FLAGS = {"STRONG_REVENUE_GROWTH", "STRONG_PROFIT_GROWTH", "PE_DISCOUNT", "PROMOTER_BUYING"}
NEGATIVE_FLAGS = {"REVENUE_DECLINE", "PE_PREMIUM", "PROMOTER_SELLING"}


def _score_fundamental(flags: list[dict]) -> int:
    score = 0
    for row in flags:
        flag = row.get("flag", "")
        if flag in POSITIVE_FLAGS:
            score += 1
        elif flag in NEGATIVE_FLAGS:
            score -= 1
    return score


def _score_concall(analysis: dict | None) -> int:
    if not analysis:
        return 0
    tone = analysis.get("management_tone", "neutral")
    return {"positive": 2, "neutral": 0, "negative": -2}.get(tone, 0)


def _score_macro(sector: str) -> int:
    try:
        impacts = _get_macro_impacts(sector)
    except Exception:
        return 0
    score = 0
    for row in impacts:
        imp = row.get("impact", "NEUTRAL")
        if imp == "GREEN":
            score += 1
        elif imp == "RED":
            score -= 1
    return score


def _label(score: float) -> str:
    if score > 3:
        return "H"
    if score >= 0:
        return "M"
    return "L"


def _upsert_verdict(stock_id: int, run_date: str, growth_label: str, entry_exit: str, score: float, components: dict) -> None:
    db = get_client()
    db.table("verdicts").upsert(
        {
            "stock_id": stock_id,
            "run_date": run_date,
            "growth_label": growth_label,
            "entry_exit": entry_exit,
            "score": score,
            "components_json": components,
        },
        on_conflict="stock_id,run_date",
    ).execute()


def score_stock(nse_code: str, sector: str, run_date: str) -> dict | None:
    stock_id = get_stock_id(nse_code)
    if stock_id is None:
        return None

    tech = _get_technical(stock_id)
    fund_flags = _get_fundamental_flags(stock_id, run_date)
    concall = _get_latest_concall(stock_id)

    t_score = _score_technical(tech.get("signal") if tech else None)
    f_score = _score_fundamental(fund_flags)
    c_score = _score_concall(concall)
    m_score = _score_macro(sector)

    total = t_score + f_score + c_score + m_score
    growth_label = _label(total)
    entry_exit = tech.get("signal", "hold") if tech else "hold"

    components = {
        "technical": t_score,
        "fundamental": f_score,
        "concall": c_score,
        "macro": m_score,
    }

    _upsert_verdict(stock_id, run_date, growth_label, entry_exit, total, components)
    log.info("%s → %s / %s (score=%.1f)", nse_code, growth_label, entry_exit.upper(), total)

    return {
        "nse_code": nse_code,
        "growth_label": growth_label,
        "entry_exit": entry_exit,
        "score": total,
        "components": components,
    }


def run(stocks: list[dict], run_date: str) -> list[dict]:
    results = []
    for s in stocks:
        v = score_stock(s["nse_code"], s["sector"], run_date)
        if v:
            results.append(v)
    return results
