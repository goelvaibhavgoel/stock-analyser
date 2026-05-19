"""Fetch daily market data from NSEIndia.com, screener.in, and Groww.in.

Sources per stock per run:
  1. NSEIndia quote API   → CMP, % change, market cap, 52w high/low,
                            current PE, sector PE (fallback), today's volume
  2. screener.in chart API → DMA-50, DMA-200 (+ volume as fallback)
  3. Groww.in /technicals  → 5-day daily volumes (7d proxy) + 25-day avg (30d proxy)
                              Industry PE (preferred over NSE)

All data lands in daily_quotes (upserted on stock_id + date).
"""

import json
import logging
import re
import time
from datetime import date, datetime, timezone

import requests

from storage.db import get_client, get_stock_id

log = logging.getLogger(__name__)

# ── NSEIndia ─────────────────────────────────────────────────────────────────

NSE_BASE = "https://www.nseindia.com"
NSE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/",
}

SCREENER_BASE = "https://www.screener.in/company"
SCREENER_CHART_URL = "https://www.screener.in/api/company/{cid}/chart/"
SCREENER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Referer": "https://www.screener.in/",
    "X-Requested-With": "XMLHttpRequest",
}

GROWW_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Origin": "https://groww.in",
    "Referer": "https://groww.in/",
}


def _nse_session() -> requests.Session:
    """Open an NSEIndia session (cookie warm-up required before API calls)."""
    s = requests.Session()
    s.headers.update(NSE_HEADERS)
    try:
        s.get(NSE_BASE, timeout=15)
        time.sleep(1)
    except Exception as exc:
        log.warning("NSE homepage warm-up failed: %s", exc)
    return s


def _fetch_nse_quote(session: requests.Session, nse_code: str) -> dict | None:
    # Two calls: main quote for price/PE, trade_info section for market cap & volume
    base_url = f"{NSE_BASE}/api/quote-equity?symbol={nse_code}"
    try:
        r = session.get(base_url, timeout=15)
        r.raise_for_status()
        quote = r.json()
        # trade info lives in a separate section when market is closed
        r2 = session.get(base_url + "&section=trade_info", timeout=15)
        r2.raise_for_status()
        trade_section = r2.json()
        # merge marketDeptOrderBook from trade_info section into main quote
        if trade_section.get("marketDeptOrderBook"):
            quote["marketDeptOrderBook"] = trade_section["marketDeptOrderBook"]
        return quote
    except Exception as exc:
        log.warning("%s: NSE quote fetch failed: %s", nse_code, exc)
        return None


def _parse_nse_quote(data: dict) -> dict:
    pi    = data.get("priceInfo", {})
    meta  = data.get("metadata", {})
    trade = data.get("marketDeptOrderBook", {}).get("tradeInfo", {})

    whl = pi.get("weekHighLow", {})
    total_cap = trade.get("totalMarketCap")
    # NSE returns totalTradedVolume in lakh shares → multiply by 1e5 for absolute shares
    raw_vol = trade.get("totalTradedVolume")
    volume_shares = round(float(raw_vol) * 1e5) if raw_vol is not None else None

    return {
        "cmp":          pi.get("lastPrice"),
        "pct_change":   pi.get("pChange"),
        "week_52_high": whl.get("max"),
        "week_52_low":  whl.get("min"),
        "volume_today": volume_shares,
        # NSE totalMarketCap is already in crores
        "market_cap_cr": round(float(total_cap), 2) if total_cap else None,
        "pe":           meta.get("pdSymbolPe"),
        "sector_pe":    meta.get("pdSectorPe"),
    }


# ── screener.in chart API ─────────────────────────────────────────────────────

def _get_screener_company_id(nse_code: str) -> str | None:
    """Extract screener.in numeric company ID from the company page HTML."""
    for suffix in ["consolidated/", ""]:
        url = f"{SCREENER_BASE}/{nse_code}/{suffix}"
        try:
            r = requests.get(url, headers={
                "User-Agent": NSE_HEADERS["User-Agent"],
                "Accept-Language": "en-US,en;q=0.9",
            }, timeout=20)
            if r.status_code == 404:
                continue
            r.raise_for_status()
            html = r.text
            break
        except Exception:
            continue
    else:
        return None

    m = re.search(r'data-company-id=["\'](\d+)["\']', html)
    if m:
        return m.group(1)
    m = re.search(r'"company_id"\s*:\s*(\d+)', html)
    return m.group(1) if m else None


def _chart_api(company_id: str, query: str, days: int) -> dict[str, list]:
    """Call screener.in chart API → {metric_name: [[ts_ms, value], ...]}."""
    url = SCREENER_CHART_URL.format(cid=company_id)
    try:
        r = requests.get(
            url, headers=SCREENER_HEADERS,
            params={"q": query, "days": days}, timeout=20,
        )
        r.raise_for_status()
        datasets = r.json().get("datasets", [])
        return {ds["metric"]: ds.get("values", []) for ds in datasets}
    except Exception as exc:
        log.warning("screener chart API error (cid=%s q=%s): %s", company_id, query, exc)
        return {}


def _to_float(v) -> float | None:
    """Convert a value to float, returning None for NA/null/non-numeric."""
    if v is None:
        return None
    try:
        f = float(v)
        return None if f != f else f   # reject NaN
    except (TypeError, ValueError):
        return None


def _latest(series: list) -> float | None:
    for entry in reversed(series):
        v = _to_float(entry[1]) if len(entry) > 1 else None
        if v is not None:
            return v
    return None


def _volume_7d(series: list) -> list[dict]:
    """Collect last 5 trading days of volume (used as proxy for 7-day avg).

    Handles two entry formats returned by screener.in:
      - [unix_ms, value]          (older format)
      - ['YYYY-MM-DD', value, ...] (current format)
    """
    out = []
    for entry in reversed(series):
        try:
            vol = float(entry[1]) if len(entry) > 1 and entry[1] is not None else None
        except (TypeError, ValueError):
            continue
        if not vol or vol <= 0:
            continue
        e0 = entry[0]
        if isinstance(e0, str) and len(e0) == 10:  # 'YYYY-MM-DD'
            dt = e0
        else:
            try:
                dt = datetime.fromtimestamp(float(e0) / 1000, tz=timezone.utc).date().isoformat()
            except (TypeError, ValueError):
                continue
        out.append({"date": dt, "volume": int(vol)})
        if len(out) == 5:
            break
    return list(reversed(out))


def _avg_volume(series: list, n: int = 25) -> float | None:
    """Sum last 25 trading days (5 weeks) and divide by 25 — proxy for 30d avg.
    Used as screener.in fallback when Groww volume is unavailable."""
    vals = []
    for entry in series:
        try:
            v = float(entry[1]) if len(entry) > 1 and entry[1] is not None else None
            if v and v > 0:
                vals.append(v)
        except (TypeError, ValueError):
            continue
    recent = vals[-n:]
    if len(recent) < 20:
        return None
    return round(sum(recent) / 25, 0)


def _fetch_screener_chart_data(nse_code: str) -> dict:
    cid = _get_screener_company_id(nse_code)
    if not cid:
        log.warning("%s: screener.in company ID not found", nse_code)
        return {}

    # 60 calendar days ≈ 42 trading days — enough for DMA values + 25-day volume window
    chart = _chart_api(cid, "Price-DMA50-DMA200-Volume", days=60)
    vol_series = chart.get("Volume", [])

    return {
        "dma_50":        _latest(chart.get("DMA50", [])),
        "dma_200":       _latest(chart.get("DMA200", [])),
        "volume_7d":     _volume_7d(vol_series) or None,
        "avg_volume_30d": _avg_volume(vol_series, 25),
    }


# ── Groww.in volume + industry PE ────────────────────────────────────────────

GROWW_TECH_URL = "https://groww.in/stocks/{slug}/technicals"


def _fetch_groww_technicals(groww_slug: str) -> dict:
    """Fetch volume data from Groww.in technicals page.

    Daily delivery section  → last 5 days of totalVolume → 7d avg proxy (÷5)
    liveCandles (daily OHLCV) → last 25 entries → 30d avg proxy (÷25)

    Returns dict with volume_7d (JSONB list) and avg_volume_30d, plus
    sector_pe if available. Empty dict on any failure.
    """
    url = GROWW_TECH_URL.format(slug=groww_slug)
    try:
        r = requests.get(url, headers={**GROWW_HEADERS, "Accept": "text/html"}, timeout=20)
        r.raise_for_status()
        html = r.text
    except Exception as exc:
        log.warning("Groww technicals fetch failed (%s): %s", groww_slug, exc)
        return {}

    m = re.search(r'id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not m:
        log.warning("Groww: __NEXT_DATA__ not found for %s", groww_slug)
        return {}

    try:
        page_data = json.loads(m.group(1))
    except json.JSONDecodeError as exc:
        log.warning("Groww: JSON parse error for %s: %s", groww_slug, exc)
        return {}

    pp = page_data.get("props", {}).get("pageProps", {})
    result: dict = {}

    # ── Daily delivery: last 5 trading days → 7d avg proxy ───────────────────
    vol_stats = pp.get("stocksVolumeStatsData", {}).get("data", [])
    if vol_stats:
        volume_7d = [
            {"date": d["startDate"], "volume": int(d["totalVolume"])}
            for d in vol_stats
            if d.get("totalVolume") and d.get("startDate")
        ]
        if volume_7d:
            result["volume_7d"] = volume_7d

    # ── liveCandles (daily OHLCV): last 25 entries → 30d avg proxy (÷25) ─────
    candles = pp.get("liveCandles") or []
    if len(candles) >= 5:
        last_25 = candles[-25:]
        total = sum(int(c["volume"]) for c in last_25 if c.get("volume"))
        result["avg_volume_30d"] = round(total / 25, 0)

    # ── Industry PE from stats ────────────────────────────────────────────────
    stats = pp.get("stockData", {}).get("stats", {})
    industry_pe = stats.get("industryPe") or stats.get("sectorPe")
    if industry_pe:
        result["sector_pe"] = float(industry_pe)

    return result


# ── storage ───────────────────────────────────────────────────────────────────

def _sanitize(row: dict) -> dict:
    """Convert any non-numeric / NA string values to None before DB write."""
    clean = {}
    for k, v in row.items():
        if k == "volume_7d":       # jsonb — keep as-is
            clean[k] = v
        elif isinstance(v, str):
            clean[k] = _to_float(v)
        else:
            clean[k] = v
    return clean


def _upsert(stock_id: int, row: dict) -> None:
    get_client().table("daily_quotes").upsert(
        {"stock_id": stock_id, "date": date.today().isoformat(), **_sanitize(row)},
        on_conflict="stock_id,date",
    ).execute()


# ── public API ────────────────────────────────────────────────────────────────

def fetch_and_store(stock: dict, nse_session: requests.Session) -> bool:
    nse_code: str = stock["nse_code"]
    stock_id = get_stock_id(nse_code)
    if stock_id is None:
        log.warning("Stock %s not in DB", nse_code)
        return False

    row: dict = {}

    nse_raw = _fetch_nse_quote(nse_session, nse_code)
    if nse_raw:
        row.update(_parse_nse_quote(nse_raw))

    # screener.in: DMA-50/200 + volume fallback for stocks without a Groww slug
    row.update(_fetch_screener_chart_data(nse_code))

    # Groww.in technicals: preferred volume source + industry PE
    groww_slug = stock.get("groww_slug")
    if groww_slug:
        groww_data = _fetch_groww_technicals(groww_slug)
        if groww_data:
            row.update(groww_data)
            log.debug("%s: Groww volume+PE fetched (slug=%s)", nse_code, groww_slug)
    else:
        log.debug("%s: no groww_slug — using screener.in volume fallback", nse_code)

    if not row:
        log.warning("%s: no market data fetched", nse_code)
        return False

    _upsert(stock_id, row)
    log.info(
        "%s: CMP=%.2f (%.2f%%) DMA50=%.0f DMA200=%.0f cap=%.0f Cr",
        nse_code,
        row.get("cmp") or 0,
        row.get("pct_change") or 0,
        row.get("dma_50") or 0,
        row.get("dma_200") or 0,
        row.get("market_cap_cr") or 0,
    )
    return True


def run(stocks: list[dict]) -> dict:
    session = _nse_session()
    ok = failed = 0
    for i, s in enumerate(stocks):
        if i > 0:
            time.sleep(1)
        if fetch_and_store(s, session):
            ok += 1
        else:
            failed += 1
    log.info("Daily quotes: %d ok, %d failed", ok, failed)
    return {"rows_written": ok, "stocks_skipped": failed}
