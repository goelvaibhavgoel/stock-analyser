"""Analyse new concall PDFs using OpenAI gpt-4o-mini. Hash-gated."""

import json
import logging
import re
from pathlib import Path

import pdfplumber
from openai import OpenAI

from storage.cache import sha256_of_str, get_analysis_cache, set_analysis_cache, download_raw
from storage.db import get_client, get_all_stocks

log = logging.getLogger(__name__)

PROMPT_PATH = Path(__file__).parent.parent / "prompts" / "concall.md"
PROMPT_VERSION = "v1"
MODEL = "gpt-4o-mini"
MAX_TEXT_CHARS = 14_000


def _load_prompt() -> str:
    return PROMPT_PATH.read_text()


def _extract_text(pdf_bytes: bytes) -> str:
    import io
    text = ""
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                t = page.extract_text() or ""
                text += t + "\n"
    except Exception as exc:
        log.warning("pdfplumber failed: %s", exc)

    if len(text.strip()) < 100:
        # OCR fallback
        try:
            import pytesseract
            from PIL import Image
            import io as _io
            import fitz  # pymupdf — not always available; graceful fallback
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            for page in doc:
                pix = page.get_pixmap(dpi=150)
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                text += pytesseract.image_to_string(img) + "\n"
        except Exception as exc:
            log.warning("OCR fallback failed: %s", exc)

    return text.strip()


def _call_openai(prompt: str, pdf_text: str) -> dict:
    client = OpenAI()
    response = client.chat.completions.create(
        model=MODEL,
        temperature=0,
        max_tokens=800,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": prompt},
            {"role": "user", "content": f"Analyse this concall transcript. Return JSON only.\n\n{pdf_text[:MAX_TEXT_CHARS]}"},
        ],
    )
    raw = response.choices[0].message.content or "{}"
    return json.loads(raw)


def _get_pending_concalls() -> list[dict]:
    db = get_client()
    return (
        db.table("concalls")
        .select("id,stock_id,content_hash,storage_path")
        .is_("json_analysis", "null")
        .execute()
        .data
    )


def _stock_code_map() -> dict[int, str]:
    stocks = get_all_stocks()
    return {s["id"]: s["nse_code"] for s in stocks}


def _update_concall(concall_id: int, analysis: dict) -> None:
    from datetime import datetime, timezone
    db = get_client()
    db.table("concalls").update({
        "json_analysis": analysis,
        "analysed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", concall_id).execute()


def run() -> list[dict]:
    """Analyse all pending concalls. Returns list of result dicts."""
    pending = _get_pending_concalls()
    if not pending:
        log.info("No pending concalls to analyse.")
        return []

    prompt = _load_prompt()
    id_to_code = _stock_code_map()
    results = []

    for row in pending:
        nse_code = id_to_code.get(row["stock_id"], "UNKNOWN")
        try:
            pdf_bytes = download_raw(row["storage_path"], bucket="concall-pdfs")
        except Exception as exc:
            log.warning("%s: failed to download PDF from storage: %s", nse_code, exc)
            continue

        pdf_text = _extract_text(pdf_bytes)
        input_hash = sha256_of_str(prompt + pdf_text[:MAX_TEXT_CHARS] + PROMPT_VERSION)

        cached = get_analysis_cache(input_hash)
        if cached:
            log.info("%s: concall analysis cache hit", nse_code)
            _update_concall(row["id"], cached)
            results.append({"nse_code": nse_code, "cache_hit": True, **cached})
            continue

        log.info("%s: calling OpenAI for concall analysis", nse_code)
        try:
            analysis = _call_openai(prompt, pdf_text)
        except Exception as exc:
            log.error("%s: OpenAI call failed: %s", nse_code, exc)
            continue

        set_analysis_cache(input_hash, analysis, PROMPT_VERSION)
        _update_concall(row["id"], analysis)
        results.append({"nse_code": nse_code, "cache_hit": False, **analysis})

    return results
