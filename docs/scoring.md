# Verdict Scoring — How H/M/L Labels Are Computed

> **Source file:** [`analysis/score.py`](../analysis/score.py)
> **Schema:** [`supabase/migrations/0005_verdicts.sql`](../supabase/migrations/0005_verdicts.sql)
> **Depends on:** technical_signals, fundamental_flags, concalls, macro_event_impacts

---

## Overview

The verdict synthesiser is a **deterministic, rule-based** aggregator — no LLM, no machine learning, no subjective interpretation. It reads the outputs of the four upstream pipeline phases, assigns a numeric score to each, sums them, and maps the total to one of three labels:

| Label | Meaning | Score range |
|---|---|---|
| **H** (High conviction) | Strong bullish signals across multiple factors | > 3 |
| **M** (Medium / watch) | Mixed or neutral signals | 0 to 3 (inclusive) |
| **L** (Low / avoid) | Bearish signals dominate | < 0 |

Every run writes one `verdicts` row per stock (upserted on `stock_id, run_date`). The full `components_json` breakdown is stored for auditability — the dashboard shows why each stock got its label.

---

## The Four Score Components

```
total_score = technical_score + fundamental_score + concall_score + macro_score
```

### 1. Technical score

**Source:** Latest row in `technical_signals` for this stock (most recent `run_date`).

```python
def _score_technical(signal: str | None) -> int:
    return {"entry": 2, "hold": 0, "exit": -2}.get(signal or "hold", 0)
```

| Signal | Score |
|---|---|
| `entry` | +2 |
| `hold` | 0 |
| `exit` | −2 |

The signal itself is also stored as `verdicts.entry_exit` — it carries through to the dashboard badge regardless of the final label.

**Range:** −2 to +2

See [docs/technical.md](technical.md) for the full signal rules (golden cross, death cross, volume spike).

---

### 2. Fundamental score

**Source:** All `fundamental_flags` rows for this stock on the current `run_date`.

Each flag contributes independently:

```python
POSITIVE_FLAGS = {"STRONG_REVENUE_GROWTH", "STRONG_PROFIT_GROWTH", "PE_DISCOUNT", "PROMOTER_BUYING"}
NEGATIVE_FLAGS = {"REVENUE_DECLINE", "PE_PREMIUM", "PROMOTER_SELLING"}

def _score_fundamental(flags: list[dict]) -> int:
    score = 0
    for row in flags:
        if row["flag"] in POSITIVE_FLAGS:
            score += 1
        elif row["flag"] in NEGATIVE_FLAGS:
            score -= 1
    return score
```

| Flag | Score |
|---|---|
| `STRONG_REVENUE_GROWTH` | +1 |
| `STRONG_PROFIT_GROWTH` | +1 |
| `PE_DISCOUNT` | +1 |
| `PROMOTER_BUYING` | +1 |
| `REVENUE_DECLINE` | −1 |
| `PE_PREMIUM` | −1 |
| `PROMOTER_SELLING` | −1 |

A stock can have any combination of flags — scores accumulate. Maximum possible: +4 (all positives raised). Minimum possible: −3 (all negatives raised).

**Range:** −3 to +4

See [docs/fundamentals.md](fundamentals.md) for flag threshold rules.

---

### 3. Concall score

**Source:** Most recent `concalls.json_analysis` where `json_analysis IS NOT NULL` (any date — not limited to the current run's date).

```python
def _score_concall(analysis: dict | None) -> int:
    if not analysis:
        return 0
    tone = analysis.get("management_tone", "neutral")
    return {"positive": 2, "neutral": 0, "negative": -2}.get(tone, 0)
```

| `management_tone` | Score |
|---|---|
| `positive` | +2 |
| `neutral` | 0 |
| `negative` | −2 |
| (no concall found) | 0 |

The concall tone carries the same weight as a technical entry/exit signal. Management confidence (or lack thereof) is treated as a strong forward-looking indicator.

**Range:** −2 to +2

See [docs/concall.md](concall.md) for how `management_tone` is extracted.

---

### 4. Macro score

**Source:** `macro_event_impacts` rows for this stock's sector, from events in the last **30 days**.

```python
MACRO_LOOKBACK_DAYS = 30

def _score_macro(sector: str) -> int:
    impacts = _get_macro_impacts(sector)   # last 30 days, this sector only
    score = 0
    for row in impacts:
        if row["impact"] == "GREEN":
            score += 1
        elif row["impact"] == "RED":
            score -= 1
    return score
```

| Impact | Score |
|---|---|
| `GREEN` | +1 per event |
| `NEUTRAL` | 0 per event |
| `RED` | −1 per event |

Unlike the other components, the macro score **accumulates per event**. If the RBI cut rates twice and one rate cut in the last 30 days and both events scored Banking as `RED`, a banking stock receives −2 from macro. In calm policy periods (0–1 events), the macro contribution is typically 0 or ±1.

**Range:** Unbounded (depends on number of macro events in the window). Typical range: −3 to +3.

**Two-step query design:** The macro lookup uses two sequential Supabase queries because PostgREST does not support cross-table filtering in a single request:
```python
# Step 1: get event IDs with recent event_date
events    = db.table("macro_events").select("id").gte("event_date", cutoff).execute().data
event_ids = [e["id"] for e in events]
# Step 2: filter impacts by sector and event_id
impacts   = db.table("macro_event_impacts")
              .select("impact")
              .eq("sector", sector)
              .in_("event_id", event_ids)
              .execute().data
```

See [docs/macro.md](macro.md) for how events and impacts are generated.

---

## Label Thresholds

```python
def _label(score: float) -> str:
    if score > 3:
        return "H"
    if score >= 0:
        return "M"
    return "L"
```

| Condition | Label |
|---|---|
| `score > 3` | **H** |
| `0 ≤ score ≤ 3` | **M** |
| `score < 0` | **L** |

### Why these thresholds

The maximum possible score from technical alone is +2. To reach H (> 3), a stock needs at least two additional positive signals from fundamentals, concall, or macro. This makes H labels genuinely earned — not triggered by a single strong indicator.

The M band is wide (0 to 3) by design. Most stocks in most 15-day windows will have mixed or neutral signals. M means "no strong case to avoid or buy" — the human analyst should review further.

L is triggered as soon as the score turns negative. Any single strong negative signal (exit signal, management tone negative, three RED macro events) can push a stock to L.

---

## Score Examples

### Example 1 — High conviction entry

| Component | Value | Score |
|---|---|---|
| Technical | `entry` (golden cross) | +2 |
| Fundamental | `STRONG_REVENUE_GROWTH` + `STRONG_PROFIT_GROWTH` | +2 |
| Concall | `positive` tone | +2 |
| Macro | 0 events in 30 days | 0 |
| **Total** | | **+6 → H** |

### Example 2 — Avoid

| Component | Value | Score |
|---|---|---|
| Technical | `exit` (death cross) | −2 |
| Fundamental | `PE_PREMIUM` | −1 |
| Concall | `negative` tone | −2 |
| Macro | 2× `RED` events | −2 |
| **Total** | | **−7 → L** |

### Example 3 — Typical hold

| Component | Value | Score |
|---|---|---|
| Technical | `hold` | 0 |
| Fundamental | `PE_DISCOUNT` | +1 |
| Concall | `neutral` tone | 0 |
| Macro | 1× `NEUTRAL`, 1× `GREEN` | +1 |
| **Total** | | **+2 → M** |

---

## What is Stored

```sql
create table verdicts (
    id              bigserial primary key,
    stock_id        bigint not null references stocks(id) on delete cascade,
    run_date        date not null,
    growth_label    text not null,      -- "H", "M", or "L"
    entry_exit      text not null,      -- "entry", "hold", or "exit"
    score           numeric not null,   -- raw total score
    components_json jsonb,              -- {"technical": 2, "fundamental": 1, ...}
    unique(stock_id, run_date)
);
```

The `components_json` column stores the full breakdown:
```json
{
  "technical":    2,
  "fundamental":  1,
  "concall":      0,
  "macro":       -1
}
```

This is displayed in the dashboard's per-stock detail page, so an analyst can see exactly which factors drove the verdict. The label and score are summary outputs; the components are the audit trail.

---

## Score vs Label — Two Separate Signals

The verdict row carries **two independent signals** that appear separately in the dashboard:

| Field | What it represents | Where it comes from |
|---|---|---|
| `growth_label` (H/M/L) | Multi-factor conviction rating | Weighted sum of all four components |
| `entry_exit` | Technical trade signal | Passed through directly from `technical_signals.signal` |

A stock can be `H / hold` — strong fundamentals + positive concall + favourable macro, but no golden or death cross yet. It can also be `L / entry` — a golden cross just fired, but everything else is bearish (rare but possible during lagging indicator behaviour). The dashboard shows both independently, letting the analyst decide.

---

## Idempotency

```python
db.table("verdicts").upsert(
    {...},
    on_conflict="stock_id,run_date",
).execute()
```

Running the score phase twice on the same day overwrites the existing row with identical values. No duplicates are created. All four input queries also read the same data on both runs (technical signals and fundamentals are also upserted idempotently), so the score is deterministic for a given run date.

---

## Limitations & known gaps

| Gap | Impact | Future fix |
|---|---|---|
| All four components are equally weighted within their categories | Strong fundamentals can be cancelled by a lagging death cross | Add configurable weights per component |
| Macro score is unbounded | High-event periods (budget week, multiple RBI meetings) can dominate total score | Cap macro contribution at ±3 |
| H threshold (> 3) is fixed | Does not adapt to market regime | Make threshold configurable via `config/watchlist.yaml` |
| No time decay on signals | A death cross from 14 days ago weighs the same as one from today | Add recency weighting on technical signal age |
| Concall uses the most recent filing regardless of date | A 6-month-old positive tone is still counted | Add recency cutoff (e.g., ignore concalls > 90 days old) |
| No sector-relative scoring | An L in a historically bearish sector is treated the same as an L in a bullish one | Add sector-relative baseline |
