"""Scrape screener.in for annual financials, quarterly results, PE history, and promoter holding.

Fetch-once logic
────────────────
Annual rows (FY24, FY25, FY26) are written once and never re-fetched unless missing.
Quarterly rows marked is_pending=True are re-checked on every run (results may be out).
The 12m PE is re-fetched on every run (it's a market-derived reference point).
"""

import logging
import re
import time
from datetime import date, datetime, timezone

import requests
from bs4 import BeautifulSoup

from storage.cache import sha256_of_bytes, upload_raw, raw_exists
from storage.db import get_client, get_stock_id

log = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}
DELAY_SECS = 1.5
SCREENER_BASE = "https://www.screener.in/company"
SCREENER_CHART = "https://www.screener.in/api/company/{cid}/chart/"
CHART_HEADERS = {**HEADERS, "Accept": "application/json",
                 "Referer": "https://www.screener.in/",
                 "X-Requested-With": "XMLHttpRequest"}

# Target annual FY labels (screener.in "Mar YYYY" maps to FY year)
TARGET_FYS = {"FY24", "FY25", "FY26"}


# ── helpers ───────────────────────────────────────────────────────────────────

def _current_fy() -> int:
    """Return current fiscal year end year (e.g. 2027 if today is May 2026)."""
    t = date.today()
    return t.year + 1 if t.month >= 4 else t.year


def _mar_label_to_fy(label: str) -> str:
    """Convert screener.in header "Mar 2024" → "FY24"."""
    parts = label.strip().split()
    if len(parts) == 2 and parts[0] == "Mar":
        return f"FY{parts[1][2:]}"
    return label


def _quarter_label_to_fy_q(label: str) -> tuple[str, str] | None:
    """
    Convert screener.in quarterly header to (fiscal_year, quarter).
    "Jun 2025" → ("FY26", "Q1")   "Sep 2025" → ("FY26", "Q2")
    "Dec 2025" → ("FY26", "Q3")   "Mar 2025" → ("FY25", "Q4")
    """
    parts = label.strip().split()
    if len(parts) != 2:
        return None
    month, year_str = parts[0], parts[1]
    try:
        year = int(year_str)
    except ValueError:
        return None
    mapping = {
        "Jun": ("Q1", 1), "Sep": ("Q2", 1),
        "Dec": ("Q3", 1), "Mar": ("Q4", 0),
    }
    if month not in mapping:
        return None
    q, fy_offset = mapping[month]
    fy = f"FY{str(year + fy_offset)[2:]}"
    return fy, q


def _is_quarter_end_passed(fy: str, q: str) -> bool:
    """Return True if the quarter's end date is in the past (results may exist)."""
    fy_year = 2000 + int(fy[2:])
    end_dates = {
        "Q1": date(fy_year - 1, 6, 30),
        "Q2": date(fy_year - 1, 9, 30),
        "Q3": date(fy_year - 1, 12, 31),
        "Q4": date(fy_year, 3, 31),
    }
    return date.today() > end_dates.get(q, date(9999, 1, 1))


def _float(text: str) -> float | None:
    try:
        return float(text.replace(",", "").replace("%", "").strip())
    except (ValueError, AttributeError):
        return None


# ── HTML fetch + cache ────────────────────────────────────────────────────────

def _fetch_page(screener_code: str) -> tuple[bytes, bool] | None:
    """Fetch screener.in page for a stock. Returns (html_bytes, is_consolidated).

    Tries consolidated first; falls back to standalone if consolidated is
    missing target FYs (e.g. results published standalone before consolidation).
    """
    pages = []
    for suffix, consolidated in [("consolidated/", True), ("", False)]:
        url = f"{SCREENER_BASE}/{screener_code}/{suffix}"
        try:
            r = requests.get(url, headers=HEADERS, timeout=20)
            if r.status_code == 404:
                continue
            r.raise_for_status()
            pages.append((r.content, consolidated))
        except Exception as exc:
            log.warning("%s: screener.in fetch failed (%s): %s", screener_code, url, exc)

    if not pages:
        return None
    if len(pages) == 1:
        return pages[0]

    # Both pages loaded — pick the one with more target FYs in annual table
    def _count_target_fys(content: bytes) -> int:
        soup = BeautifulSoup(content, "lxml")
        section = soup.find("section", {"id": "profit-loss"})
        if not section:
            return 0
        table = section.find("table")
        if not table:
            return 0
        headers = [th.get_text(strip=True) for th in table.find("tr").find_all("th")[1:]]
        return sum(1 for h in headers if _mar_label_to_fy(h) in TARGET_FYS)

    consolidated_count = _count_target_fys(pages[0][0])
    standalone_count   = _count_target_fys(pages[1][0])
    return pages[0] if consolidated_count >= standalone_count else pages[1]


def _get_html(screener_code: str) -> tuple[bytes, bool] | None:
    """Return cached HTML if unchanged; otherwise fetch and cache."""
    result = _fetch_page(screener_code)
    if not result:
        return None
    content, consolidated = result
    h = sha256_of_bytes(content)
    if not raw_exists(h, "html"):
        upload_raw(content, h, "html")
    return content, consolidated


# ── parsing: annual P&L ───────────────────────────────────────────────────────

def _parse_annual(soup: BeautifulSoup) -> list[dict]:
    """Extract FY revenue, EBITDA margin, net profit from annual P&L table."""
    section = soup.find("section", {"id": "profit-loss"})
    if not section:
        return []
    table = section.find("table")
    if not table:
        return []

    rows = table.find_all("tr")
    if not rows:
        return []

    headers = [th.get_text(strip=True) for th in rows[0].find_all("th")[1:]]

    def row_values(keyword: str) -> list[str]:
        for tr in rows[1:]:
            cells = tr.find_all("td")
            if not cells:
                continue
            if keyword.lower() in cells[0].get_text(strip=True).lower():
                return [c.get_text(strip=True) for c in cells[1:]]
        return []

    rev_vals    = row_values("sales") or row_values("revenue")
    # For banking/NBFC companies, screener shows "Financing Margin %" or NIM instead of OPM%
    opm_vals    = (row_values("opm %") or row_values("operating profit %") or
                   row_values("financing margin %") or row_values("net interest margin") or
                   row_values("nim %"))
    profit_vals = row_values("net profit")

    results = []
    for i, hdr in enumerate(headers):
        fy = _mar_label_to_fy(hdr)
        if fy not in TARGET_FYS:
            continue
        results.append({
            "period":       fy,
            "revenue":      _float(rev_vals[i]) if i < len(rev_vals) else None,
            "ebitda_margin": _float(opm_vals[i]) if i < len(opm_vals) else None,
            "net_profit":   _float(profit_vals[i]) if i < len(profit_vals) else None,
        })
    return results


# ── parsing: quarterly P&L ────────────────────────────────────────────────────

def _parse_quarterly(soup: BeautifulSoup) -> list[dict]:
    """Extract quarterly revenue and net profit for last 2 FYs."""
    section = soup.find("section", {"id": "quarters"})
    if not section:
        return []
    table = section.find("table")
    if not table:
        return []

    rows = table.find_all("tr")
    if not rows:
        return []

    headers = [th.get_text(strip=True) for th in rows[0].find_all("th")[1:]]
    fy_now  = _current_fy()
    # Include 3 fiscal years so FY25 data is captured even when fy_now=2027
    target_fys = {
        f"FY{str(fy_now)[2:]}",
        f"FY{str(fy_now - 1)[2:]}",
        f"FY{str(fy_now - 2)[2:]}",
    }

    def row_values(keyword: str) -> list[str]:
        for tr in rows[1:]:
            cells = tr.find_all("td")
            if not cells:
                continue
            if keyword.lower() in cells[0].get_text(strip=True).lower():
                return [c.get_text(strip=True) for c in cells[1:]]
        return []

    rev_vals    = row_values("sales") or row_values("revenue")
    profit_vals = row_values("net profit")

    results = []
    for i, hdr in enumerate(headers):
        parsed = _quarter_label_to_fy_q(hdr)
        if not parsed:
            continue
        fy, q = parsed
        if fy not in target_fys:
            continue

        rev_raw    = rev_vals[i] if i < len(rev_vals) else ""
        profit_raw = profit_vals[i] if i < len(profit_vals) else ""

        rev    = _float(rev_raw)
        profit = _float(profit_raw)
        pending = rev is None and profit is None and _is_quarter_end_passed(fy, q)

        results.append({
            "fiscal_year": fy,
            "quarter":     q,
            "revenue":     rev,
            "net_profit":  profit,
            "is_pending":  pending,
        })
    return results


# ── parsing: ratios (PE, promoter, 52w) ──────────────────────────────────────

def _parse_ratios(soup: BeautifulSoup) -> dict:
    """Extract industry PE, 52-week high/low, promoter % from ratios section."""
    out: dict = {}
    for li in soup.find_all("li", class_=re.compile(r"flex")):
        name_el = li.find("span", class_="name")
        val_el  = li.find("span", class_=re.compile(r"value"))
        if not name_el or not val_el:
            continue
        name = name_el.get_text(strip=True).lower()
        val  = _float(val_el.get_text(strip=True))
        if "industry pe" in name:
            out["sector_pe"] = val
        elif "52 week high" in name or "high / low" in name:
            # Some layouts show "High / Low" as "2700 / 1800"
            raw = val_el.get_text(strip=True)
            if "/" in raw:
                parts = raw.split("/")
                out["week_52_high"] = _float(parts[0])
                out["week_52_low"]  = _float(parts[1])
            else:
                out["week_52_high"] = val

    # Promoter holding
    section = soup.find("section", {"id": "shareholding"})
    if section:
        table = section.find("table")
        if table:
            for tr in table.find_all("tr"):
                cells = tr.find_all("td")
                if not cells:
                    continue
                if "promoter" in cells[0].get_text(strip=True).lower():
                    out["promoter_pct"] = _float(cells[-1].get_text(strip=True))
                    break
    return out


# ── screener.in chart API: PE history ────────────────────────────────────────

def _get_company_id(soup: BeautifulSoup) -> str | None:
    tag = soup.find(attrs={"data-company-id": True})
    if tag:
        return tag["data-company-id"]
    m = re.search(r'"company_id"\s*:\s*(\d+)', str(soup))
    return m.group(1) if m else None


def _chart_api(cid: str, query: str, days: int) -> dict[str, list]:
    url = SCREENER_CHART.format(cid=cid)
    try:
        r = requests.get(url, headers=CHART_HEADERS,
                         params={"q": query, "days": days}, timeout=20)
        r.raise_for_status()
        datasets = r.json().get("datasets", [])
        return {ds["metric"]: ds.get("values", []) for ds in datasets}
    except Exception as exc:
        log.warning("screener chart API error (cid=%s q=%s): %s", cid, query, exc)
        return {}


def _pe_12m_ago(pe_series: list) -> float | None:
    """Return PE value closest to 365 days ago."""
    target_ms = (datetime.now(timezone.utc).timestamp() - 365 * 86400) * 1000
    best = best_val = None
    for ts_ms, val in pe_series:
        if val is None:
            continue
        if best is None or abs(ts_ms - target_ms) < abs(best - target_ms):
            best = ts_ms
            best_val = float(val)
    return best_val


def _fetch_pe_history(soup: BeautifulSoup) -> dict:
    cid = _get_company_id(soup)
    if not cid:
        return {}
    chart = _chart_api(cid, "PE", days=400)
    pe_series = chart.get("PE", [])
    if not pe_series:
        return {}
    current_pe = float(pe_series[-1][1]) if pe_series[-1][1] is not None else None
    pe_12m     = _pe_12m_ago(pe_series)
    return {"pe": current_pe, "pe_12m": pe_12m}


# ── storage ───────────────────────────────────────────────────────────────────

def _annual_needs_fetch(stock_id: int) -> bool:
    """True if any target FY annual row is missing from the DB."""
    db = get_client()
    existing = (
        db.table("fundamentals")
        .select("period")
        .eq("stock_id", stock_id)
        .in_("period", list(TARGET_FYS))
        .execute()
        .data
    )
    found = {r["period"] for r in existing}
    return not TARGET_FYS.issubset(found)


def _quarter_needs_fetch(stock_id: int, fy: str, q: str) -> bool:
    """True if the quarter is missing or still marked pending."""
    db = get_client()
    result = (
        db.table("quarterly_results")
        .select("is_pending")
        .eq("stock_id", stock_id)
        .eq("fiscal_year", fy)
        .eq("quarter", q)
        .execute()
        .data
    )
    if not result:
        return True                   # not in DB at all
    return bool(result[0]["is_pending"])


def _upsert_annual(stock_id: int, rows: list[dict], ratios: dict, pe_hist: dict) -> None:
    db = get_client()
    for row in rows:
        db.table("fundamentals").upsert(
            {
                "stock_id":     stock_id,
                "period":       row["period"],
                "revenue":      row["revenue"],
                "ebitda_margin": row["ebitda_margin"],
                "net_profit":   row["net_profit"],
                "promoter_pct": ratios.get("promoter_pct"),
                "sector_pe":    ratios.get("sector_pe"),
                "pe":           pe_hist.get("pe"),
                "pe_12m":       pe_hist.get("pe_12m"),
            },
            on_conflict="stock_id,period",
        ).execute()


def _upsert_quarterly(stock_id: int, rows: list[dict]) -> None:
    db = get_client()
    for row in rows:
        db.table("quarterly_results").upsert(
            {"stock_id": stock_id, **row},
            on_conflict="stock_id,fiscal_year,quarter",
        ).execute()


# ── public entry point ────────────────────────────────────────────────────────

def fetch_and_store(nse_code: str, screener_code: str | None = None) -> bool:
    screener_code = screener_code or nse_code
    stock_id = get_stock_id(nse_code)
    if stock_id is None:
        log.warning("Stock %s not in DB", nse_code)
        return False

    # Determine what actually needs a network fetch
    need_annual  = _annual_needs_fetch(stock_id)
    fy_now  = _current_fy()
    target_quarters = [
        (f"FY{str(fy_now)[2:]}", q)     for q in ["Q1","Q2","Q3","Q4"]
    ] + [
        (f"FY{str(fy_now-1)[2:]}", q)   for q in ["Q1","Q2","Q3","Q4"]
    ] + [
        (f"FY{str(fy_now-2)[2:]}", q)   for q in ["Q1","Q2","Q3","Q4"]
    ]
    need_quarters = [fq for fq in target_quarters if _quarter_needs_fetch(stock_id, *fq)]

    if not need_annual and not need_quarters:
        log.info("%s: all static data already in DB — skipping screener.in fetch", nse_code)
        # Still update PE history (it's a market-derived reference)
        result = _get_html(screener_code)
        if result:
            soup = BeautifulSoup(result[0], "lxml")
            pe_hist = _fetch_pe_history(soup)
            if pe_hist:
                db = get_client()
                db.table("fundamentals").update(
                    {"pe": pe_hist.get("pe"), "pe_12m": pe_hist.get("pe_12m")}
                ).eq("stock_id", stock_id).execute()
        return True

    result = _get_html(screener_code)
    if not result:
        log.warning("%s: could not fetch screener.in page", nse_code)
        return False

    html_bytes, _ = result
    soup = BeautifulSoup(html_bytes, "lxml")

    ratios   = _parse_ratios(soup)
    pe_hist  = _fetch_pe_history(soup)

    if need_annual:
        annual_rows = _parse_annual(soup)
        if annual_rows:
            _upsert_annual(stock_id, annual_rows, ratios, pe_hist)
            log.info("%s: upserted %d annual periods, pe=%.1f, pe_12m=%.1f",
                     nse_code, len(annual_rows),
                     pe_hist.get("pe") or 0, pe_hist.get("pe_12m") or 0)
        else:
            log.warning("%s: no annual data parsed", nse_code)

    if need_quarters:
        quarterly_rows = _parse_quarterly(soup)
        # Filter to only the quarters that need updating
        need_set = {(fy, q) for fy, q in need_quarters}
        to_write = [r for r in quarterly_rows if (r["fiscal_year"], r["quarter"]) in need_set]
        if to_write:
            _upsert_quarterly(stock_id, to_write)
            log.info("%s: upserted %d quarterly rows", nse_code, len(to_write))

    return True


def run(stocks: list[dict]) -> None:
    for i, s in enumerate(stocks):
        if i > 0:
            time.sleep(DELAY_SECS)
        fetch_and_store(s["nse_code"], screener_code=s.get("screener_code"))
