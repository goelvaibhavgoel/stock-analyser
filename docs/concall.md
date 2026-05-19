# Concall Analysis — Pipeline, Extraction & LLM Design

> **Source files:**
> - Ingestion: [`ingest/concalls.py`](../ingest/concalls.py)
> - Analysis: [`analysis/concall_llm.py`](../analysis/concall_llm.py)
> - Prompt: [`prompts/concall.md`](../prompts/concall.md)

---

## Overview

The concall pipeline detects new earnings call transcripts and investor presentations filed on BSE, extracts their text, and passes them through OpenAI `gpt-4o-mini` to produce a structured JSON summary. Every step is **hash-gated** — a file that has been seen before is never re-downloaded, and a PDF that has been analysed before is never re-sent to the API.

**Cost profile:** After the first run, each 15-day refresh only calls OpenAI for PDFs filed in the last 15 days. For a 100-stock watchlist this is typically 5–15 calls per run at ~$0.001–0.005 each.

---

## Stage 1 — BSE Announcement Polling

**File:** `ingest/concalls.py` → `fetch_and_store(nse_code, bse_code)`

### API used
```
GET https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w
```

Parameters sent per stock:

| Parameter | Value | Meaning |
|---|---|---|
| `strScrip` | BSE code (e.g. `532540`) | Which company |
| `strPrevDate` | 20 days ago (YYYYMMDD) | Lookback window |
| `strToDate` | Today (YYYYMMDD) | End of window |
| `strSearch` | `P` | Published announcements |
| `strType` | `C` | Corporate announcements |

Response: `{"Table": [...announcement objects...]}`. Each object has `NEWSSUB` (title) and `ATTACHMENTNAME` (PDF filename).

### Concall detection — keyword filter
An announcement is treated as a concall if its title (`NEWSSUB`) contains any of these keywords (case-insensitive):

```python
CONCALL_KEYWORDS = [
    "concall",
    "transcript",
    "investor presentation",
    "earnings call",
    "analyst meet",
]
```

Announcements that don't match (dividends, board meetings, regulatory filings, etc.) are ignored.

### PDF URL construction
If `ATTACHMENTNAME` is a bare filename (not a full URL), it is prefixed:
```
https://www.bseindia.com/xml-data/corpfiling/AttachLive/{filename}
```

### Hash-deduplication
Before downloading, the pipeline checks whether a row with this PDF's `content_hash` already exists in the `concalls` table. If it does, the file is skipped entirely — no download, no storage call.

If it is new:
1. PDF is downloaded (30-second timeout)
2. `sha256` of the raw bytes is computed
3. PDF is uploaded to Supabase Storage bucket `concall-pdfs` at path `{sha256}.pdf`
4. A row is inserted into `concalls` with `json_analysis = null` (pending LLM analysis)

### Delay
1-second sleep between PDF downloads to avoid hammering BSE servers.

---

## Stage 2 — PDF Text Extraction

**File:** `analysis/concall_llm.py` → `_extract_text(pdf_bytes)`

Concall PDFs come in two types:
- **Text-based PDFs** — selectable text embedded, common for typed transcripts
- **Scanned PDFs** — image pages, common for older presentations or investor day decks

A two-step extraction strategy handles both.

### Step 1 — pdfplumber (primary)
```python
with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
    for page in pdf.pages:
        text += page.extract_text() or ""
```

`pdfplumber` uses `pdfminer` under the hood. It handles multi-column layouts better than raw `pdfminer` and returns `None` (not an error) for image pages.

### Step 2 — pytesseract OCR (fallback)
If `pdfplumber` returns fewer than 100 characters of text, the PDF is treated as image-based and OCR is attempted:

```python
# Requires: pip install pytesseract Pillow pymupdf
# System dep: tesseract-ocr (apt-get install tesseract-ocr in CI)
doc = fitz.open(stream=pdf_bytes, filetype="pdf")
for page in doc:
    pix = page.get_pixmap(dpi=150)
    img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    text += pytesseract.image_to_string(img) + "\n"
```

DPI=150 is a balance between OCR accuracy and processing speed. Higher DPI (e.g., 300) gives slightly better results on small text but takes ~4× longer.

### Text truncation
Only the first **14,000 characters** of extracted text are sent to OpenAI. This fits comfortably within `gpt-4o-mini`'s context window while keeping token costs low. Concall transcripts are typically 10,000–40,000 words; the first 14,000 characters (~2,500 words) covers the opening management commentary, which contains the most forward-looking statements.

---

## Stage 3 — LLM Analysis

**File:** `analysis/concall_llm.py` → `_call_openai(prompt, pdf_text)`

### Model
`gpt-4o-mini` — chosen for:
- Structured JSON extraction does not require GPT-4o/Opus-level reasoning
- ~10× cheaper than GPT-4o at similar accuracy for this task
- Fast responses (2–4 seconds per call)

### Call parameters
```python
client.chat.completions.create(
    model="gpt-4o-mini",
    temperature=0,                          # deterministic output
    max_tokens=800,                         # JSON schema is compact
    response_format={"type": "json_object"},# enforces valid JSON
    messages=[
        {"role": "system", "content": prompt},
        {"role": "user",   "content": f"Analyse this concall transcript. Return JSON only.\n\n{pdf_text[:14000]}"},
    ],
)
```

`temperature=0` ensures that for the same input, the same output is always produced. Combined with the analysis cache, this means re-analysing an existing PDF always returns the exact same JSON.

`response_format={"type": "json_object"}` forces the model to return valid JSON — it cannot return prose, markdown, or partial JSON. If the model cannot produce valid JSON for any reason, the API raises an error.

### Prompt design

**File:** `prompts/concall.md` (version-controlled)

```markdown
<!-- PROMPT_VERSION: v1 -->

You are a financial analyst specializing in Indian listed companies...

Required JSON schema:
{
  "revenue_guidance":  "string — management's stated revenue/sales outlook...",
  "margin_guidance":   "string — EBITDA or PAT margin outlook...",
  "capex_plans":       "string — capital expenditure plans mentioned...",
  "key_risks":         ["array of strings — top 3 risks mentioned by management"],
  "management_tone":   "positive | neutral | negative"
}
```

Key design choices:

| Choice | Reason |
|---|---|
| Concise value strings (< 200 chars) | Avoids verbose paraphrasing; forces the model to extract, not summarise |
| `key_risks` as array, 1–3 items | Structured for display in dashboard; prevents open-ended lists |
| `management_tone` as enum | Three-way enum maps directly to the scoring formula (+2 / 0 / -2) |
| "Return ONLY the JSON object" | Prevents the model from wrapping output in markdown code blocks |

### Output schema

```json
{
  "revenue_guidance":  "1.5% to 3.5% growth year-on-year in constant currency terms",
  "margin_guidance":   "EBIT margins expected in the range of 20–22%",
  "capex_plans":       "not stated",
  "key_risks":         ["macro uncertainty in US/EU", "talent retention costs", "currency headwinds"],
  "management_tone":   "positive"
}
```

`"not stated"` is the canonical value when management did not address that topic — the model is instructed to use this literal string rather than `null`, empty string, or "N/A".

---

## Stage 4 — Two-level Caching

### Level 1 — Content hash (raw file deduplication)
Before any PDF is downloaded, its `sha256` hash is checked against `concalls.content_hash` in Postgres. If found, the file is skipped entirely. This prevents re-downloading the same PDF on every run.

### Level 2 — Analysis cache (LLM output deduplication)
Before any OpenAI call, the `analysis_cache` table is checked:

```python
input_hash = sha256(system_prompt + pdf_text[:14000] + PROMPT_VERSION)
cached = get_analysis_cache(input_hash)
if cached:
    return cached   # no API call
```

The cache key includes the **prompt version** (`PROMPT_VERSION: v1` from the prompt file header). This means:
- Same PDF + same prompt → cache hit → zero cost
- Same PDF + updated prompt (v2) → cache miss → fresh API call

This design lets you safely iterate on the prompt without worrying about stale analysis from the old prompt polluting new verdicts.

### Cache invalidation
Update the prompt file header from `v1` to `v2`:
```markdown
<!-- PROMPT_VERSION: v2 -->
```
All existing cache entries for the old prompt version are automatically bypassed. No manual database cleanup needed.

---

## Stage 5 — Storage & verdict contribution

### What gets stored

| Table | What |
|---|---|
| `concalls` | One row per unique PDF: `stock_id`, `filing_date`, `source_url`, `content_hash`, `storage_path`, `json_analysis` |
| `analysis_cache` | One row per unique `(prompt + text + version)` combination |
| `concall-pdfs` bucket | Raw PDF bytes at `{sha256}.pdf` |

### Contribution to scoring
`analysis/score.py` reads the latest `concalls.json_analysis` for each stock and maps `management_tone`:

```
positive → +2
neutral  →  0
negative → -2
```

If no concall analysis exists for a stock (no filings in BSE in the lookback window, or all extractions failed), the concall component is 0.

---

## Error handling

| Error | Behaviour |
|---|---|
| BSE API timeout / error | Warning logged, stock skipped for this run |
| PDF download fails | Warning logged, filing skipped |
| PDF is not actually a PDF (wrong content-type) | Skipped, warning logged |
| pdfplumber crashes | Falls back to OCR |
| OCR fails / pymupdf not installed | Warning logged, text = empty string |
| OpenAI API error (rate limit, server error) | Error logged, `concalls.json_analysis` stays `null`, retried next run |
| OpenAI returns malformed JSON | JSON parse error caught, filing skipped |

The pipeline **never crashes on a per-stock error** — it logs and continues to the next stock.

---

## Limitations & known gaps

| Gap | Impact | Future fix |
|---|---|---|
| 14,000-char truncation | Misses guidance stated late in the call (e.g., Q&A section) | Summarise in two passes: management commentary + Q&A separately |
| OCR quality on scanned presentations | Poor text → poor analysis | Add image pre-processing (contrast, deskew) before OCR |
| BSE lookback is fixed at 20 days | Concalls filed > 20 days ago are never picked up | On first run, do a 90-day lookback to backfill history |
| `management_tone` is the only scoring input | Rich guidance (specific revenue %s) is stored but not scored | Add a `guidance_score` numeric field from revenue/margin guidance |
| No de-duplication within a quarter | If a company files both a transcript and a presentation, both are analysed | Add quarter-level deduplication — keep the longer/richer document |
