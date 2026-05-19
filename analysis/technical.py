"""Technical signal generation from screener.in-sourced DMA and volume data.

DMA-50 and DMA-200 come directly from screener.in (stored in daily_quotes).
Volume ratio (today vs 30d avg) replaces the old z-score.
Signal rules (golden/death cross + volume) are unchanged in logic.
"""

import logging

from storage.db import get_client, get_stock_id, upsert_technical_signal

log = logging.getLogger(__name__)


def _get_last_two_quotes(stock_id: int) -> list[dict]:
    """Return the two most recent daily_quotes rows for a stock (newest first)."""
    db = get_client()
    result = (
        db.table("daily_quotes")
        .select("date,dma_50,dma_200,volume_today,avg_volume_30d")
        .eq("stock_id", stock_id)
        .order("date", desc=True)
        .limit(2)
        .execute()
    )
    return result.data or []


def _volume_ratio(volume_today, avg_volume_30d) -> float:
    """today's volume / 30d avg — proxy for the old vol z-score."""
    try:
        v = float(volume_today)
        a = float(avg_volume_30d)
        return round(v / a, 4) if a > 0 else 1.0
    except (TypeError, ValueError, ZeroDivisionError):
        return 1.0


def _signal(dma_50: float, dma_200: float,
            prev_50: float, prev_200: float,
            vol_ratio: float) -> str:
    """
    entry — golden cross (50 crosses above 200) with elevated volume,
             OR strong uptrend (50>200) with vol spike (ratio > 2×)
    exit  — death cross (50 crosses below 200)
    hold  — everything else
    """
    golden = (prev_50 <= prev_200) and (dma_50 > dma_200)
    death  = (prev_50 >= prev_200) and (dma_50 < dma_200)

    if golden and vol_ratio > 1.3:
        return "entry"
    if death:
        return "exit"
    if dma_50 > dma_200 and vol_ratio > 2.0:
        return "entry"
    return "hold"


def analyse(nse_code: str, run_date: str) -> dict | None:
    stock_id = get_stock_id(nse_code)
    if stock_id is None:
        log.warning("%s: not in DB — skipping", nse_code)
        return None

    quotes = _get_last_two_quotes(stock_id)
    if not quotes:
        log.warning("%s: no daily_quotes rows — run prices phase first", nse_code)
        return None

    today = quotes[0]
    prev  = quotes[1] if len(quotes) > 1 else quotes[0]

    dma_50  = today.get("dma_50")
    dma_200 = today.get("dma_200")
    if dma_50 is None or dma_200 is None:
        log.warning("%s: DMA values missing in daily_quotes", nse_code)
        return None

    prev_50  = prev.get("dma_50")  or dma_50
    prev_200 = prev.get("dma_200") or dma_200

    vol_ratio = _volume_ratio(today.get("volume_today"), today.get("avg_volume_30d"))
    sig = _signal(float(dma_50), float(dma_200), float(prev_50), float(prev_200), vol_ratio)

    row = {
        "stock_id": stock_id,
        "run_date": run_date,
        "dma_50":   round(float(dma_50), 2),
        "dma_200":  round(float(dma_200), 2),
        "rsi_14":   None,       # RSI no longer computed (no raw OHLCV)
        "vol_z20":  vol_ratio,  # repurposed column: volume ratio vs 30d avg
        "signal":   sig,
    }
    upsert_technical_signal(row)
    log.info("%s → %s (DMA50=%.0f DMA200=%.0f vol_ratio=%.2f)",
             nse_code, sig.upper(), float(dma_50), float(dma_200), vol_ratio)
    return row


def run(stocks: list[dict], run_date: str) -> list[dict]:
    results = []
    for s in stocks:
        row = analyse(s["nse_code"], run_date)
        if row:
            row["nse_code"] = s["nse_code"]
            results.append(row)
    return results
