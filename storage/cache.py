"""Hash utilities and Supabase Storage raw-cache helpers."""

import hashlib
import os
from pathlib import Path

from storage.db import get_client


def sha256_of_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_of_str(text: str) -> str:
    return sha256_of_bytes(text.encode())


def sha256_of_file(path: str | Path) -> str:
    with open(path, "rb") as f:
        return sha256_of_bytes(f.read())


# ---------------------------------------------------------------------------
# Supabase Storage — raw-cache bucket
# ---------------------------------------------------------------------------
RAW_BUCKET = "raw-cache"
CONCALL_BUCKET = "concall-pdfs"


def _storage(bucket: str):
    return get_client().storage.from_(bucket)


def upload_raw(content: bytes, content_hash: str, ext: str, bucket: str = RAW_BUCKET) -> str:
    """Upload bytes to Supabase Storage if not already present. Returns the storage path."""
    path = f"{content_hash}.{ext}"
    try:
        # Check if file already exists by trying to get its metadata
        _storage(bucket).download(path)
        return path  # already exists
    except Exception:
        pass
    _storage(bucket).upload(
        path,
        content,
        {"content-type": _content_type(ext), "x-upsert": "true"},
    )
    return path


def download_raw(path: str, bucket: str = RAW_BUCKET) -> bytes:
    return _storage(bucket).download(path)


def raw_exists(content_hash: str, ext: str, bucket: str = RAW_BUCKET) -> bool:
    path = f"{content_hash}.{ext}"
    try:
        _storage(bucket).download(path)
        return True
    except Exception:
        return False


def _content_type(ext: str) -> str:
    return {
        "html": "text/html",
        "pdf": "application/pdf",
        "json": "application/json",
    }.get(ext, "application/octet-stream")


# ---------------------------------------------------------------------------
# Supabase DB — analysis_cache table (keyed by input_hash)
# ---------------------------------------------------------------------------

def get_analysis_cache(input_hash: str) -> dict | None:
    db = get_client()
    result = (
        db.table("analysis_cache")
        .select("output_json")
        .eq("input_hash", input_hash)
        .limit(1)
        .execute()
    )
    return result.data[0]["output_json"] if result.data else None


def set_analysis_cache(input_hash: str, output_json: dict, prompt_version: str) -> None:
    db = get_client()
    db.table("analysis_cache").upsert(
        {
            "input_hash": input_hash,
            "output_json": output_json,
            "prompt_version": prompt_version,
        },
        on_conflict="input_hash",
    ).execute()
