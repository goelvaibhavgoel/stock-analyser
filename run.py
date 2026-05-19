#!/usr/bin/env python3
"""Idempotent pipeline orchestrator.

Usage:
    python run.py --phase technical
    python run.py --phase fundamental
    python run.py --phase concall
    python run.py --phase macro
    python run.py --phase score
    python run.py --phase all
"""

import argparse
import logging
import sys
from datetime import date

import yaml
from tabulate import tabulate

from storage.db import create_run, finish_run, upsert_stock, delete_unlisted_stocks

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("run")


def load_watchlist(path: str = "config/watchlist.yaml") -> list[dict]:
    with open(path) as f:
        return yaml.safe_load(f)["stocks"]


def sync_watchlist(stocks: list[dict]) -> None:
    """Upsert watchlist stocks and remove any stocks no longer in the list."""
    active_codes = [s["nse_code"] for s in stocks]
    removed = delete_unlisted_stocks(active_codes)
    if removed:
        log.info("Removed %d stock(s) no longer in watchlist", removed)
    for s in stocks:
        upsert_stock(
            nse_code=s["nse_code"],
            bse_code=s.get("bse_code", ""),
            name=s["name"],
            sector=s["sector"],
            market_cap_bucket=s.get("market_cap_bucket", ""),
        )


def phase_technical(stocks: list[dict], run_date: str) -> None:
    from ingest import prices as price_ingest
    from analysis import technical

    log.info("=== INGEST: daily market data (NSEIndia + screener.in) ===")
    summary = price_ingest.run(stocks)
    log.info("Daily quotes: %d ok, %d failed", summary["rows_written"], summary["stocks_skipped"])

    log.info("=== ANALYSIS: technical ===")
    signals = technical.run(stocks, run_date)

    if signals:
        headers = ["Stock", "Signal", "DMA-50", "DMA-200", "Vol Ratio"]
        rows = [
            [
                s["nse_code"],
                s["signal"].upper(),
                f"{s['dma_50']:.2f}",
                f"{s['dma_200']:.2f}",
                f"{s['vol_z20']:.2f}" if s.get("vol_z20") is not None else "—",
            ]
            for s in signals
        ]
        print("\n" + tabulate(rows, headers=headers, tablefmt="rounded_outline"))
    else:
        log.warning("No technical signals generated.")


def phase_fundamental(stocks: list[dict], run_date: str) -> None:
    from ingest import fundamentals as fund_ingest
    from analysis import fundamental

    log.info("=== INGEST: fundamentals ===")
    fund_ingest.run(stocks)

    log.info("=== ANALYSIS: fundamental ===")
    flags = fundamental.run(stocks, run_date)

    if flags:
        headers = ["Stock", "Flag", "Rationale"]
        rows = [[f["nse_code"], f["flag"], f["rationale"]] for f in flags]
        print("\n" + tabulate(rows, headers=headers, tablefmt="rounded_outline"))
    else:
        log.info("No fundamental flags generated.")


def phase_concall(stocks: list[dict], _run_date: str) -> None:
    from ingest import concalls as concall_ingest
    from analysis import concall_llm

    log.info("=== INGEST: concall PDFs ===")
    concall_ingest.run(stocks)

    log.info("=== ANALYSIS: concall LLM ===")
    results = concall_llm.run()

    headers = ["Stock", "Cache Hit", "Revenue Guidance", "Tone"]
    rows = [
        [
            r["nse_code"],
            "YES" if r.get("cache_hit") else "NO",
            r.get("revenue_guidance", "—")[:60],
            r.get("management_tone", "—"),
        ]
        for r in results
    ]
    if rows:
        print("\n" + tabulate(rows, headers=headers, tablefmt="rounded_outline"))


def phase_macro(_stocks: list[dict], _run_date: str) -> None:
    from ingest import macro as macro_ingest
    from analysis import macro_llm

    log.info("=== INGEST: stock events (NSE feeds + news) ===")
    ingest_result = macro_ingest.run()
    log.info("New events ingested: %d", ingest_result.get("total_new", 0))

    log.info("=== ANALYSIS: stock event LLM ===")
    results = macro_llm.run()

    if results:
        headers = ["Event", "Summary", "Impact"]
        rows = [
            [r["event_title"][:40], r["summary"][:55], r["impact"]]
            for r in results
        ]
        print("\n" + tabulate(rows, headers=headers, tablefmt="rounded_outline"))


def phase_score(stocks: list[dict], run_date: str) -> None:
    from analysis import score

    log.info("=== SCORING: verdict synthesiser ===")
    verdicts = score.run(stocks, run_date)

    headers = ["Stock", "Label", "Signal", "Score", "Technical", "Fundamental", "Concall", "Macro"]
    rows = [
        [
            v["nse_code"],
            v["growth_label"],
            v["entry_exit"],
            f"{v['score']:.1f}",
            v["components"].get("technical", 0),
            v["components"].get("fundamental", 0),
            v["components"].get("concall", 0),
            v["components"].get("macro", 0),
        ]
        for v in verdicts
    ]
    if rows:
        print("\n" + tabulate(rows, headers=headers, tablefmt="rounded_outline"))


def main() -> None:
    parser = argparse.ArgumentParser(description="Indian Stock Analyzer pipeline")
    parser.add_argument(
        "--phase",
        choices=["technical", "fundamental", "concall", "macro", "score", "all"],
        required=True,
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Only process the first N stocks from the watchlist",
    )
    args = parser.parse_args()

    stocks = load_watchlist()
    if args.limit:
        stocks = stocks[: args.limit]
    run_date = date.today().isoformat()

    log.info("Run date: %s | Phase: %s | Stocks: %d", run_date, args.phase, len(stocks))

    run_id = create_run()
    try:
        sync_watchlist(stocks)

        if args.phase in ("technical", "all"):
            phase_technical(stocks, run_date)
        if args.phase in ("fundamental", "all"):
            phase_fundamental(stocks, run_date)
        if args.phase in ("concall", "all"):
            phase_concall(stocks, run_date)
        if args.phase in ("macro", "all"):
            phase_macro(stocks, run_date)
        if args.phase in ("score", "all"):
            phase_score(stocks, run_date)

        finish_run(run_id, status="success", notes=f"phase={args.phase}")
        log.info("Run %d finished successfully.", run_id)
    except Exception as exc:
        log.exception("Run %d failed: %s", run_id, exc)
        finish_run(run_id, status="failed", notes=str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
