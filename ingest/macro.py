"""Poll NSE RSS feeds and news sites for stock-specific events."""

import logging
import re
import warnings
from datetime import datetime, timedelta, timezone

import feedparser
import requests

from storage.cache import sha256_of_str
from storage.db import get_client

log = logging.getLogger(__name__)

# NSE archives don't have a trusted SSL cert on macOS; suppress the warning
warnings.filterwarnings("ignore", message="Unverified HTTPS request")

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}

NSE_FEEDS = [
    {
        "name": "NSE Online Announcements",
        "url": "https://nsearchives.nseindia.com/content/RSS/Online_announcements.xml",
        "source": "NSE Filing",
        "ssl_verify": False,
        "max_entries": 200,
    },
    {
        "name": "NSE Annual Reports",
        "url": "https://nsearchives.nseindia.com/content/RSS/Annual_Reports.xml",
        "source": "NSE Filing",
        "ssl_verify": False,
        "max_entries": 100,
    },
    {
        "name": "NSE Board Meetings",
        "url": "https://nsearchives.nseindia.com/content/RSS/Board_Meetings.xml",
        "source": "NSE Filing",
        "ssl_verify": False,
        "max_entries": 100,
    },
    {
        "name": "NSE Corporate Actions",
        "url": "https://nsearchives.nseindia.com/content/RSS/Corporate_action.xml",
        "source": "NSE Filing",
        "ssl_verify": False,
        "max_entries": 100,
    },
    {
        "name": "NSE Financial Results",
        "url": "https://nsearchives.nseindia.com/content/RSS/Financial_Results.xml",
        "source": "NSE Filing",
        "ssl_verify": False,
        "max_entries": 100,
    },
    {
        "name": "NSE Shareholding Pattern",
        "url": "https://nsearchives.nseindia.com/content/RSS/Shareholding_Pattern.xml",
        "source": "NSE Filing",
        "ssl_verify": False,
        "max_entries": 100,
    },
]

NEWS_FEEDS = [
    {
        "name": "MoneyControl Latest",
        "url": "https://www.moneycontrol.com/rss/latestnews.xml",
        "source": "MoneyControl",
        "ssl_verify": True,
        "max_entries": 50,
    },
    {
        "name": "MoneyControl Business",
        "url": "https://www.moneycontrol.com/rss/business.xml",
        "source": "MoneyControl",
        "ssl_verify": True,
        "max_entries": 50,
    },
]

# NSE archive URLs embed the NSE code right after /corporate/ and before _ or /
# e.g. /corporate/MAXHEALTH_18052026... or /corporate/ZAGGLE/filename.pdf
_NSE_URL_CODE_RE = re.compile(r"/corporate/([A-Z][A-Z0-9&%\-]{1,19})[_/]", re.IGNORECASE)


def _fetch_feed(url: str, ssl_verify: bool) -> feedparser.FeedParserDict:
    """Fetch RSS via requests (handles NSE SSL issues) then parse with feedparser."""
    try:
        resp = requests.get(url, headers=_HEADERS, timeout=20, verify=ssl_verify)
        resp.raise_for_status()
        return feedparser.parse(resp.content)
    except Exception as exc:
        log.warning("Failed to fetch feed %s: %s", url, exc)
        return feedparser.FeedParserDict(entries=[])


def _load_watchlist() -> dict[str, int]:
    """Returns {nse_code: stock_id} for all stocks in DB."""
    db = get_client()
    rows = db.table("stocks").select("id,nse_code").execute().data or []
    return {r["nse_code"].upper(): r["id"] for r in rows}


def _match_stock(title: str, link: str, watchlist: dict[str, int]) -> int | None:
    """Return stock_id if this entry is about a watchlist stock, else None.

    Priority: NSE archive URL code → word-boundary NSE code in title.
    """
    m = _NSE_URL_CODE_RE.search(link)
    if m:
        code = m.group(1).upper()
        if code in watchlist:
            return watchlist[code]

    title_upper = title.upper()
    for code, stock_id in watchlist.items():
        if re.search(r"\b" + re.escape(code) + r"\b", title_upper):
            return stock_id

    return None


def _event_exists(stock_id: int, content_hash: str) -> bool:
    db = get_client()
    r = (
        db.table("stock_events")
        .select("id")
        .eq("stock_id", stock_id)
        .eq("content_hash", content_hash)
        .limit(1)
        .execute()
    )
    return bool(r.data)


def _parse_pub_date(entry) -> datetime:
    """Parse NSE's non-standard date format (e.g. '18-May-2026 23:09:01')."""
    raw = entry.get("published") or entry.get("updated") or ""
    for fmt in ("%d-%b-%Y %H:%M:%S", "%d-%b-%Y"):
        try:
            return datetime.strptime(raw.strip(), fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    # feedparser standard fallback
    if entry.get("published_parsed"):
        try:
            return datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
        except Exception:
            pass
    return datetime.now(timezone.utc)


def _build_raw_title(title: str, summary: str) -> str:
    """Compose the text sent to the LLM: description is preferred over bare company name."""
    summary = summary.strip()
    if summary and summary.lower() != title.lower():
        return f"{title}: {summary}"[:600]
    return title[:600]


def _insert_event(stock_id: int, event: dict) -> None:
    db = get_client()
    db.table("stock_events").insert(
        {
            "stock_id": stock_id,
            "event_date": event["event_date"],
            "raw_title": _build_raw_title(event["title"], event["summary"]),
            "source_name": event["source"],
            "source_link": event["link"],
            "content_hash": event["content_hash"],
        }
    ).execute()


def _parse_feed(feed_config: dict, watchlist: dict[str, int], cutoff: datetime | None = None) -> int:
    feed_url = feed_config["url"]
    source = feed_config["source"]
    ssl_verify = feed_config.get("ssl_verify", True)
    max_entries = feed_config.get("max_entries", 50)

    new_count = 0
    feed = _fetch_feed(feed_url, ssl_verify)

    for entry in feed.entries[:max_entries]:
        title = entry.get("title", "").strip()
        link = entry.get("link", "").strip()
        summary = entry.get("summary", entry.get("description", "")).strip()

        if not title:
            continue

        pub_dt = _parse_pub_date(entry)

        # For date-windowed runs: NSE feeds are newest-first, so stop early
        if cutoff and pub_dt < cutoff:
            break

        stock_id = _match_stock(title, link, watchlist)
        if stock_id is None:
            continue

        content_hash = sha256_of_str(f"{title}\n\n{summary}")
        if _event_exists(stock_id, content_hash):
            continue

        try:
            _insert_event(
                stock_id,
                {
                    "title": title,
                    "summary": summary,
                    "link": link,
                    "event_date": pub_dt.date().isoformat(),
                    "content_hash": content_hash,
                    "source": source,
                },
            )
            log.info("New stock event (stock_id=%d): %s", stock_id, title[:80])
            new_count += 1
        except Exception as exc:
            log.warning("Failed to insert stock event: %s", exc)

    return new_count


def run(backfill_days: int = 0) -> dict:
    """Fetch all NSE + news feeds and insert new stock events.

    backfill_days > 0: scan up to that many days back and lift per-feed entry caps.
    """
    watchlist = _load_watchlist()
    if not watchlist:
        log.warning("No stocks in watchlist — skipping event ingest")
        return {"total_new": 0}

    cutoff = datetime.now(timezone.utc) - timedelta(days=backfill_days) if backfill_days else None

    total_new = 0
    for feed_config in NSE_FEEDS + NEWS_FEEDS:
        cfg = feed_config if not backfill_days else {**feed_config, "max_entries": 5000}
        count = _parse_feed(cfg, watchlist, cutoff=cutoff)
        if count:
            log.info("%s: %d new events", feed_config["name"], count)
        total_new += count

    log.info("Stock event ingest complete: %d new events", total_new)
    return {"total_new": total_new}
