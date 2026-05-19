"""Fundamental analysis: CAGR, PE vs sector PE, promoter delta → flags."""

import logging

from storage.db import get_client, get_stock_id

log = logging.getLogger(__name__)

# Thresholds
REVENUE_CAGR_STRONG = 0.20      # 20% 3yr CAGR
PROFIT_CAGR_STRONG = 0.20
PE_PREMIUM_RATIO = 1.30         # stock PE > 1.3x sector PE
PE_DISCOUNT_RATIO = 0.70        # stock PE < 0.7x sector PE
PROMOTER_SELL_THRESHOLD = -2.0  # % drop in promoter holding
PROMOTER_BUY_THRESHOLD = 2.0


def _get_fundamentals(stock_id: int) -> list[dict]:
    db = get_client()
    return (
        db.table("fundamentals")
        .select("*")
        .eq("stock_id", stock_id)
        .order("period", desc=True)
        .limit(4)
        .execute()
        .data
    )


def _cagr(start: float, end: float, years: int) -> float | None:
    if not start or not end or start <= 0 or years <= 0:
        return None
    return (end / start) ** (1 / years) - 1


def _upsert_flag(stock_id: int, run_date: str, flag: str, rationale: str) -> None:
    db = get_client()
    db.table("fundamental_flags").upsert(
        {"stock_id": stock_id, "run_date": run_date, "flag": flag, "rationale": rationale},
        on_conflict="stock_id,run_date,flag",
    ).execute()


def analyse(nse_code: str, run_date: str) -> list[dict]:
    """Compute fundamental flags for one stock. Returns list of flag dicts."""
    stock_id = get_stock_id(nse_code)
    if stock_id is None:
        return []

    rows = _get_fundamentals(stock_id)
    if len(rows) < 2:
        log.warning("%s: insufficient fundamental data (%d periods)", nse_code, len(rows))
        return []

    # Sort oldest-first for CAGR
    rows_asc = sorted(rows, key=lambda r: r["period"])
    flags = []

    # Revenue CAGR
    oldest_rev = rows_asc[0].get("revenue")
    newest_rev = rows_asc[-1].get("revenue")
    years = len(rows_asc) - 1
    rev_cagr = _cagr(oldest_rev, newest_rev, years)

    if rev_cagr is not None:
        if rev_cagr >= REVENUE_CAGR_STRONG:
            flag = {"nse_code": nse_code, "flag": "STRONG_REVENUE_GROWTH",
                    "rationale": f"Revenue CAGR {rev_cagr:.1%} over {years}yr"}
            _upsert_flag(stock_id, run_date, flag["flag"], flag["rationale"])
            flags.append(flag)
        elif rev_cagr < 0:
            flag = {"nse_code": nse_code, "flag": "REVENUE_DECLINE",
                    "rationale": f"Revenue CAGR {rev_cagr:.1%} over {years}yr"}
            _upsert_flag(stock_id, run_date, flag["flag"], flag["rationale"])
            flags.append(flag)

    # Net profit CAGR
    oldest_np = rows_asc[0].get("net_profit")
    newest_np = rows_asc[-1].get("net_profit")
    np_cagr = _cagr(oldest_np, newest_np, years)

    if np_cagr is not None:
        if np_cagr >= PROFIT_CAGR_STRONG:
            flag = {"nse_code": nse_code, "flag": "STRONG_PROFIT_GROWTH",
                    "rationale": f"Net profit CAGR {np_cagr:.1%} over {years}yr"}
            _upsert_flag(stock_id, run_date, flag["flag"], flag["rationale"])
            flags.append(flag)

    # PE vs sector PE (use most recent row)
    latest = rows_asc[-1]
    pe = latest.get("pe")
    sector_pe = latest.get("sector_pe")
    if pe and sector_pe and sector_pe > 0:
        ratio = pe / sector_pe
        if ratio >= PE_PREMIUM_RATIO:
            flag = {"nse_code": nse_code, "flag": "PE_PREMIUM",
                    "rationale": f"PE {pe:.1f} is {ratio:.2f}x sector PE {sector_pe:.1f}"}
            _upsert_flag(stock_id, run_date, flag["flag"], flag["rationale"])
            flags.append(flag)
        elif ratio <= PE_DISCOUNT_RATIO:
            flag = {"nse_code": nse_code, "flag": "PE_DISCOUNT",
                    "rationale": f"PE {pe:.1f} is only {ratio:.2f}x sector PE {sector_pe:.1f}"}
            _upsert_flag(stock_id, run_date, flag["flag"], flag["rationale"])
            flags.append(flag)

    # Promoter holding delta (latest vs oldest available)
    promoter_vals = [r.get("promoter_pct") for r in rows_asc if r.get("promoter_pct") is not None]
    if len(promoter_vals) >= 2:
        delta = promoter_vals[-1] - promoter_vals[0]
        if delta <= PROMOTER_SELL_THRESHOLD:
            flag = {"nse_code": nse_code, "flag": "PROMOTER_SELLING",
                    "rationale": f"Promoter holding dropped {delta:.1f}% over {years}yr"}
            _upsert_flag(stock_id, run_date, flag["flag"], flag["rationale"])
            flags.append(flag)
        elif delta >= PROMOTER_BUY_THRESHOLD:
            flag = {"nse_code": nse_code, "flag": "PROMOTER_BUYING",
                    "rationale": f"Promoter holding rose {delta:.1f}% over {years}yr"}
            _upsert_flag(stock_id, run_date, flag["flag"], flag["rationale"])
            flags.append(flag)

    log.info("%s: %d fundamental flags", nse_code, len(flags))
    return flags


def run(stocks: list[dict], run_date: str) -> list[dict]:
    all_flags = []
    for s in stocks:
        all_flags.extend(analyse(s["nse_code"], run_date))
    return all_flags
