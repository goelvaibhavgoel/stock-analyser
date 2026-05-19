# Macro / Events — Sources, Ingestion & LLM Impact Assessment

> **Source files:**
> - Ingestion: [`ingest/macro.py`](../ingest/macro.py)
> - Analysis: [`analysis/macro_llm.py`](../analysis/macro_llm.py)
> - Prompt: [`prompts/macro.md`](../prompts/macro.md)
> - Schema: [`supabase/migrations/0007_stock_events.sql`](../supabase/migrations/0007_stock_events.sql)

---

## Overview

The macro pipeline ingests corporate filings from NSE RSS feeds and stock-specific news from MoneyControl and CNBC TV18. Each event is matched to a watchlist stock, assessed once by `gpt-4o-mini`, and stored with a 50–70 character plain-English summary and a three-way impact label (GOOD / BAD / NO_IMPACT). Re-running the pipeline on the same day hits a cache and makes zero additional OpenAI calls.

**Cost profile:** Each unique event title costs ~$0.0001 (gpt-4o-mini at 200 max tokens). A day with 20 new events across the watchlist costs under $0.003.

---

## Stage 1 — RSS Feed Polling

**File:** `ingest/macro.py`

### Feeds polled

| Feed name | URL | Source label |
|---|---|---|
| NSE Online Announcements | `nsearchives.nseindia.com/content/RSS/Online_announcements.xml` | NSE Filing |
| NSE Annual Reports | `nsearchives.nseindia.com/content/RSS/Annual_Reports.xml` | NSE Filing |
| NSE Board Meetings | `nsearchives.nseindia.com/content/RSS/Board_Meetings.xml` | NSE Filing |
| NSE Corporate Actions | `nsearchives.nseindia.com/content/RSS/Corporate_action.xml` | NSE Filing |
| NSE Financial Results | `nsearchives.nseindia.com/content/RSS/Financial_Results.xml` | NSE Filing |
| NSE Shareholding Pattern | `nsearchives.nseindia.com/content/RSS/Shareholding_Pattern.xml` | NSE Filing |
| MoneyControl Latest News | `moneycontrol.com/rss/latestnews.xml` | MoneyControl |
| CNBC TV18 Latest News | `cnbctv18.com/commonfeeds/v1/eng/rss/latest.xml` | CNBC TV18 |

RBI feeds are **not** used. All macro and regulatory data is sourced from NSE and financial news sites only.

### Stock matching

Each RSS entry is matched to a watchlist stock before storing. Two methods in priority order:

1. **NSE archive URL code** (most reliable): NSE filing URLs embed the NSE code in the path (`/corporate/<NSE_CODE>/…`). Extracted with regex `/corporate/([A-Z][A-Z0-9&%-]{0,19})/`.
2. **Word-boundary title match**: If the URL doesn't contain an NSE code (e.g., news sites), each watchlist NSE code is searched as a whole word in the entry title.

Entries that do not match any watchlist stock are **discarded**. This keeps the event table tight and avoids noise.

### Deduplication

Before inserting, the pipeline checks whether the `(stock_id, content_hash)` pair already exists:

```python
content_hash = sha256_of_str(f"{title}\n\n{summary}")
if _event_exists(stock_id, content_hash):
    continue
```

The unique constraint `unique(stock_id, content_hash)` in the DB also prevents duplicate rows on concurrent runs.

---

## Stage 2 — LLM Impact Assessment

**File:** `analysis/macro_llm.py`

### What triggers a call

Only events with `json_analysis IS NULL` in `stock_events` are sent to OpenAI. Once assessed, the row is never re-sent.

### Model and call parameters

```python
client.chat.completions.create(
    model="gpt-4o-mini",
    temperature=0,
    max_tokens=200,
    response_format={"type": "json_object"},
    messages=[
        {"role": "system", "content": prompt},     # prompts/macro.md
        {"role": "user",   "content": f"Event: {title}"},
    ],
)
```

| Parameter | Value | Reason |
|---|---|---|
| `model` | `gpt-4o-mini` | Adequate for classification; ~10× cheaper than GPT-4o |
| `temperature=0` | Disabled | Deterministic — same title always produces the same labels |
| `max_tokens=200` | Capped | JSON output is small (summary + impact label) |
| `response_format` | `json_object` | Enforces valid JSON; prevents prose or partial output |

### Prompt design

**File:** `prompts/macro.md`

```markdown
<!-- PROMPT_VERSION: v2 -->

You are a financial analyst covering Indian equity markets. You will be given the title
of a corporate filing or news item about an Indian stock listed on NSE.

Produce a JSON object with two keys:
  "summary" — plain-English, 50–70 characters, no company name or ticker
  "impact"  — GOOD | BAD | NO_IMPACT

...
```

The prompt excludes company names from the summary to keep it reusable and readable in the UI. The three-value impact label maps cleanly to UI colours (green / red / grey).

### Output schema

```json
{
  "summary": "Board approves ₹5/share interim dividend for FY26",
  "impact": "GOOD"
}
```

### Cache strategy

Before every OpenAI call, the input hash is checked against `analysis_cache`:

```python
input_hash = sha256_of_str(prompt + title + PROMPT_VERSION)
cached = get_analysis_cache(input_hash)
```

The cache key includes the full prompt text and `PROMPT_VERSION`. Updating the version string in `prompts/macro.md` (`v2` → `v3`) automatically bypasses all old cached entries.

---

## Stage 3 — Storage

### Table: `stock_events`

| Column | Type | Description |
|---|---|---|
| `stock_id` | bigint FK | The matched watchlist stock |
| `event_date` | date | Publication date of the RSS entry |
| `raw_title` | text | Original entry title (sent to LLM) |
| `event_summary` | text | 50–70 char LLM-generated summary |
| `source_name` | text | "NSE Filing", "MoneyControl", "CNBC TV18" |
| `source_link` | text | URL to the filing PDF or news article |
| `impact` | text | GOOD / BAD / NO_IMPACT |
| `content_hash` | text | SHA-256 of `title\n\nsummary` |
| `json_analysis` | jsonb | Full LLM response |
| `analysed_at` | timestamptz | When the LLM call was made |

Unique constraint: `(stock_id, content_hash)` — prevents duplicate rows per stock per event.

---

## Stage 4 — UI

### Watchlist green dot

If a stock has at least one `stock_events` row where `event_date = today`, a small green circle (●) is shown next to its NSE code in the watchlist table. This is computed client-side from a single query:

```sql
SELECT stock_id FROM stock_events WHERE stock_id IN (...) AND event_date = CURRENT_DATE
```

### Macro / Events table (stock detail page)

Displayed at the bottom of each stock detail page. Columns:

| Column | Content |
|---|---|
| Event / Update | `event_summary` (50–70 chars) |
| Source | `source_name` |
| Link | Clickable `source_link` (truncated at 40 chars) |
| Impact | "Good" (green) / "Bad" (red) / "No Impact" (grey) |

Shows up to 50 most-recent events, newest first. Events without `json_analysis` (not yet assessed) are excluded.

---

## Running the pipeline

```bash
# Full macro phase (ingest + LLM)
python run.py --phase macro

# Or as part of the full daily run
python run.py --phase all
```

Schedule daily with a cron job or task scheduler to keep events fresh.

---

## Error handling

| Error | Behaviour |
|---|---|
| RSS feed unreachable / malformed | Warning logged, that feed skipped |
| Entry missing title | Skipped |
| No watchlist stock matched | Entry discarded silently |
| DB insert fails | Warning logged, event skipped |
| OpenAI API error | Error logged, event's `json_analysis` stays null, retried next run |
| LLM returns invalid JSON | `json.loads()` raises, event skipped |
| Impact not in allowed set | Defaults to `NO_IMPACT` |

---

## Cache invalidation

To force re-analysis of all events (e.g., after a prompt rewrite):
1. Bump `PROMPT_VERSION` in `prompts/macro.md` (e.g., `v2` → `v3`)
2. Re-run `python run.py --phase macro`

Old `v2` cache entries are bypassed automatically — no DB cleanup needed.
