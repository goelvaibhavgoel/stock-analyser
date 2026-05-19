"""Poll BSE corporate announcements for concall/transcript PDFs and store them."""

import logging
import re
import time
from datetime import date, timedelta

import requests

from storage.cache import sha256_of_bytes, upload_raw
from storage.db import get_client, get_stock_id

log = logging.getLogger(__name__)

BSE_ANN_URL = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; stock-analyzer/1.0)",
    "Referer": "https://www.bseindia.com/",
}
DELAY_SECS = 1.0
LOOKBACK_DAYS = 20

CONCALL_KEYWORDS = ["concall", "transcript", "investor presentation", "earnings call", "analyst meet"]


def _is_concall(title: str) -> bool:
    t = title.lower()
    return any(k in t for k in CONCALL_KEYWORDS)


def _fetch_announcements(bse_code: str, days: int = LOOKBACK_DAYS) -> list[dict]:
    from_date = (date.today() - timedelta(days=days)).strftime("%Y%m%d")
    to_date = date.today().strftime("%Y%m%d")
    params = {
        "pageno": 1,
        "strCat": "-1",
        "strPrevDate": from_date,
        "strScrip": bse_code,
        "strSearch": "P",
        "strToDate": to_date,
        "strType": "C",
        "subcategory": "-1",
    }
    try:
        resp = requests.get(BSE_ANN_URL, params=params, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        return data.get("Table", [])
    except Exception as exc:
        log.warning("BSE API error for %s: %s", bse_code, exc)
        return []


def _download_pdf(url: str) -> bytes | None:
    try:
        resp = requests.get(url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        if "pdf" not in resp.headers.get("content-type", "").lower():
            return None
        return resp.content
    except Exception as exc:
        log.warning("Failed to download PDF %s: %s", url, exc)
        return None


def _hash_exists(content_hash: str) -> bool:
    db = get_client()
    result = db.table("concalls").select("id").eq("content_hash", content_hash).limit(1).execute()
    return bool(result.data)


def _insert_concall(stock_id: int, filing_date: str, source_url: str, content_hash: str, storage_path: str) -> None:
    db = get_client()
    db.table("concalls").insert({
        "stock_id": stock_id,
        "filing_date": filing_date,
        "source_url": source_url,
        "content_hash": content_hash,
        "storage_path": storage_path,
        "json_analysis": None,
    }).execute()


def fetch_and_store(nse_code: str, bse_code: str) -> int:
    """Fetch new concall PDFs for one stock. Returns count of new filings."""
    stock_id = get_stock_id(nse_code)
    if stock_id is None:
        return 0

    announcements = _fetch_announcements(bse_code)
    new_count = 0

    for ann in announcements:
        title = ann.get("NEWSSUB", "")
        if not _is_concall(title):
            continue

        pdf_url = ann.get("ATTACHMENTNAME", "")
        if not pdf_url:
            continue

        if not pdf_url.startswith("http"):
            pdf_url = f"https://www.bseindia.com/xml-data/corpfiling/AttachLive/{pdf_url}"

        filing_date = ann.get("NEWS_DT", date.today().isoformat())[:10]

        pdf_bytes = _download_pdf(pdf_url)
        if not pdf_bytes:
            continue

        content_hash = sha256_of_bytes(pdf_bytes)
        if _hash_exists(content_hash):
            log.info("%s: concall PDF already known (hash match)", nse_code)
            continue

        storage_path = upload_raw(pdf_bytes, content_hash, "pdf", bucket="concall-pdfs")
        _insert_concall(stock_id, filing_date, pdf_url, content_hash, storage_path)
        log.info("%s: stored new concall PDF (%s)", nse_code, title[:60])
        new_count += 1
        time.sleep(DELAY_SECS)

    return new_count


def run(stocks: list[dict]) -> dict:
    total_new = 0
    for s in stocks:
        n = fetch_and_store(s["nse_code"], s.get("bse_code", ""))
        total_new += n
    return {"new_filings": total_new}
