"""Assess stock events using gpt-4o-mini: 50-70 char summary + GOOD/BAD/NO_IMPACT."""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from openai import OpenAI

from storage.cache import get_analysis_cache, set_analysis_cache, sha256_of_str
from storage.db import get_client

log = logging.getLogger(__name__)

PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "macro.md"
PROMPT_VERSION = "v2"
MODEL = "gpt-4o-mini"

VALID_IMPACTS = {"GOOD", "BAD", "NO_IMPACT"}


def _load_prompt() -> str:
    return PROMPT_PATH.read_text()


def _get_pending_events() -> list[dict]:
    db = get_client()
    return (
        db.table("stock_events")
        .select("id,raw_title,content_hash")
        .is_("json_analysis", "null")
        .execute()
        .data
    ) or []


def _call_openai(prompt: str, title: str) -> dict:
    client = OpenAI()
    response = client.chat.completions.create(
        model=MODEL,
        temperature=0,
        max_tokens=200,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": prompt},
            {"role": "user", "content": f"Event: {title}"},
        ],
    )
    raw = response.choices[0].message.content or "{}"
    return json.loads(raw)


def _update_event(event_id: int, analysis: dict) -> None:
    db = get_client()
    impact = analysis.get("impact", "NO_IMPACT").upper()
    if impact not in VALID_IMPACTS:
        impact = "NO_IMPACT"
    summary = (analysis.get("summary") or "")[:80]
    db.table("stock_events").update(
        {
            "json_analysis": analysis,
            "event_summary": summary,
            "impact": impact,
            "analysed_at": datetime.now(timezone.utc).isoformat(),
        }
    ).eq("id", event_id).execute()


def run() -> list[dict]:
    """Analyse all pending stock events. Cached — zero API calls on re-run."""
    pending = _get_pending_events()
    if not pending:
        log.info("No pending stock events to analyse.")
        return []

    prompt = _load_prompt()
    results = []

    for ev in pending:
        title = ev.get("raw_title") or ""
        input_hash = sha256_of_str(prompt + title + PROMPT_VERSION)

        cached = get_analysis_cache(input_hash)
        if cached:
            log.info("Cache hit: %s", title[:60])
            analysis = cached
        else:
            log.info("OpenAI call: %s", title[:60])
            try:
                analysis = _call_openai(prompt, title)
            except Exception as exc:
                log.error("OpenAI failed for event %s: %s", ev["id"], exc)
                continue
            set_analysis_cache(input_hash, analysis, PROMPT_VERSION)

        _update_event(ev["id"], analysis)
        results.append(
            {
                "event_title": title,
                "summary": analysis.get("summary", ""),
                "impact": analysis.get("impact", "NO_IMPACT"),
            }
        )

    return results
