"use client";

import { createClient } from "@supabase/supabase-js";
import Link from "next/link";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { screenerCode } from "@/lib/screener_codes";

// ── Supabase browser client ───────────────────────────────────────────────────
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ── Types ─────────────────────────────────────────────────────────────────────
export type QuoteData = {
  stock_id: number;
  date: string | null;
  cmp: number | null;
  pct_change: number | null;
  pe: number | null;
  sector_pe: number | null;
  dma_50: number | null;
  dma_200: number | null;
  volume_7d: Array<{ date: string; volume: number }> | null;
  avg_volume_30d: number | null;
};

export type FundData = {
  revenue: number | null;
  net_profit: number | null;
};

export type RowData = {
  id: number;
  nse_code: string;
  name: string;
  sector: string;
  market_cap_bucket: string;
  quote: QuoteData | null;
  funds: Record<string, FundData>;
  fy26Complete: boolean;
  fy27Guidance: number | null;
  fy27Remarks:  string | null;
};

type SortField    = "cmpDma50" | "volRatio" | null;
type SortDir      = "asc" | "desc";
type StockStatus  = "on_radar" | "invested" | "not_interested";
type StatusFilter = "all" | StockStatus;

const STATUS_LABELS: Record<StockStatus, string> = {
  on_radar:       "On Radar",
  invested:       "Invested",
  not_interested: "Not Interested",
};
const STATUS_DOT: Record<StockStatus, string> = {
  on_radar:       "bg-blue-400",
  invested:       "bg-emerald-500",
  not_interested: "bg-gray-400",
};

// ── Color helpers ─────────────────────────────────────────────────────────────
const CAP_STYLE: Record<string, string> = {
  LARGE: "bg-blue-100 text-blue-700",
  MID:   "bg-purple-100 text-purple-700",
  SMALL: "bg-orange-100 text-orange-700",
};

function pctColor(v: number | null) {
  if (v == null) return "text-gray-400";
  if (v >= 20) return "text-emerald-600 font-semibold";
  if (v >= 10) return "text-emerald-500";
  if (v > 0)   return "text-gray-600";
  if (v < -10) return "text-red-500";
  return "text-orange-500";
}

function cmpPctColor(v: number | null) {
  if (v == null) return "text-gray-400";
  if (v > 0)    return "text-emerald-600";
  if (v < 0)    return "text-red-500";
  return "text-gray-500";
}

function volRatioColor(r: number | null) {
  if (r == null) return "text-gray-400";
  if (r > 1.5)  return "text-emerald-600";
  if (r > 1.0)  return "text-yellow-600";
  if (r < 0.7)  return "text-red-500";
  return "text-gray-600";
}

function fy27GuideColor(v: number | null) {
  if (v == null) return "text-gray-400";
  if (v >= 0.50) return "text-emerald-600 font-bold";
  if (v >= 0.30) return "text-emerald-600";
  if (v >= 0.20) return "text-yellow-600";
  return "text-gray-500";
}

function cmpDmaColor(v: number | null) {
  if (v == null) return "text-gray-400";
  if (v > 0)    return "text-emerald-600";
  return "text-red-500";
}

function fmt(v: number | null, decimals = 0): string {
  if (v == null) return "—";
  return v.toLocaleString("en-IN", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}

function pctFmt(v: number | null): string {
  if (v == null) return "—";
  return (v > 0 ? "+" : "") + v.toFixed(1) + "%";
}

function compute7dAvg(volume7d: QuoteData["volume_7d"]): number | null {
  if (!Array.isArray(volume7d) || volume7d.length === 0) return null;
  const vols = volume7d.map((e) => Number(e.volume)).filter((v) => v > 0);
  return vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
}

function volRatio(volume7d: QuoteData["volume_7d"], avg30d: number | null): number | null {
  const avg7 = compute7dAvg(volume7d);
  if (!avg7 || !avg30d) return null;
  return avg7 / avg30d;
}

function yoy(latest: number | null, prev: number | null): number | null {
  if (latest == null || prev == null || prev === 0) return null;
  return ((latest - prev) / Math.abs(prev)) * 100;
}

function cmpVsDma50Val(q: QuoteData | null): number | null {
  return q?.cmp && q?.dma_50
    ? ((Number(q.cmp) - Number(q.dma_50)) / Number(q.dma_50)) * 100
    : null;
}

// ── SVG icons ─────────────────────────────────────────────────────────────────
function ExternalLinkIcon() {
  return (
    <svg className="inline w-2.5 h-2.5 shrink-0 text-gray-400 hover:text-gray-600 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}

function NoteIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function TrashIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
    </svg>
  );
}

function RefreshRowIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

function SortArrows({ field, sortField, sortDir }: { field: SortField; sortField: SortField; sortDir: SortDir }) {
  if (sortField !== field) return <span className="text-gray-400 leading-none">↕</span>;
  return <span className="text-blue-600 leading-none">{sortDir === "asc" ? "↑" : "↓"}</span>;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────
// Limit large enough to cover many null-CMP days + real data beyond them
const QUOTE_ROW_MULTIPLIER = 10;

async function fetchLatestQuotes(stockIds: number[]): Promise<Record<number, QuoteData>> {
  const { data } = await supabase
    .from("daily_quotes")
    .select("stock_id,date,cmp,pct_change,pe,sector_pe,dma_50,dma_200,volume_7d,avg_volume_30d")
    .in("stock_id", stockIds)
    .order("date", { ascending: false })
    .limit(stockIds.length * QUOTE_ROW_MULTIPLIER);
  // latest row per stock (for DMA), then fallback to most recent row with real CMP
  const latest: Record<number, QuoteData> = {};
  const latestCmp: Record<number, QuoteData> = {};
  for (const q of (data ?? []) as QuoteData[]) {
    if (!latest[q.stock_id]) latest[q.stock_id] = q;
    if (!latestCmp[q.stock_id] && q.cmp != null) latestCmp[q.stock_id] = q;
  }
  for (const [idStr, row] of Object.entries(latest)) {
    const id = Number(idStr);
    if (row.cmp == null && latestCmp[id]) {
      row.cmp = latestCmp[id].cmp;
      row.pct_change = latestCmp[id].pct_change;
      row.pe = latestCmp[id].pe;
    }
  }
  return latest;
}

async function fetchLatestCmp(stockIds: number[]): Promise<Record<number, { cmp: number | null; pct_change: number | null }>> {
  // Only fetch rows where CMP is actually populated so we always show real prices
  const { data } = await supabase
    .from("daily_quotes")
    .select("stock_id,cmp,pct_change")
    .in("stock_id", stockIds)
    .not("cmp", "is", null)
    .order("date", { ascending: false })
    .limit(stockIds.length * QUOTE_ROW_MULTIPLIER);
  const map: Record<number, { cmp: number | null; pct_change: number | null }> = {};
  for (const q of (data ?? []) as any[]) {
    if (!map[q.stock_id]) map[q.stock_id] = { cmp: q.cmp, pct_change: q.pct_change };
  }
  return map;
}

// ── Constants ─────────────────────────────────────────────────────────────────
type BtnState = "idle" | "triggering" | "waiting" | "done" | "error";
const QUICK_WAIT_S    = 3 * 60;
const ALL_WAIT_S      = 18 * 60;
const SINGLE_WAIT_S   = 5 * 60;        // 5 min — refresh_single.yml
const AUTO_REFRESH_MS = 5 * 60 * 1000;

const SECTORS = ["Auto","Banking","Chemicals","Defence","Energy","FMCG","Healthcare","IT","Infra","Metals","Pharma","Realty"];
const CAP_BUCKETS = ["LARGE","MID","SMALL"];

function Spinner() {
  return <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />;
}

function RefreshBtn({ state, countdown, onClick, label }: { state: BtnState; countdown: number; onClick: () => void; label: string }) {
  const busy = state !== "idle" && state !== "done" && state !== "error";
  const base = "inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors select-none";
  let col = "bg-white border border-gray-300 hover:border-gray-500 text-gray-700 cursor-pointer";
  if (busy)              col = "bg-gray-50 border border-gray-200 text-gray-400 cursor-not-allowed";
  if (state === "done")  col = "bg-emerald-50 border border-emerald-400 text-emerald-700 cursor-not-allowed";
  if (state === "error") col = "bg-red-50 border border-red-400 text-red-600 cursor-not-allowed";
  return (
    <button onClick={onClick} disabled={busy} className={`${base} ${col}`}>
      {state === "idle"       && <>{label}</>}
      {state === "triggering" && <><Spinner /> Triggering…</>}
      {state === "waiting"    && <><Spinner /> {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, "0")}</>}
      {state === "done"       && <>✓ Updated</>}
      {state === "error"      && <>✗ Failed</>}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function WatchlistClient({
  initialRows,
  stocksWithEventsArr,
  latestDate: initialDate,
}: {
  initialRows: RowData[];
  stocksWithEventsArr: number[];
  latestDate: string;
}) {
  const router = useRouter();
  const stockIds = initialRows.map((r) => r.id);
  const stocksWithEvents = new Set(stocksWithEventsArr);

  const [quoteMap, setQuoteMap] = useState<Record<number, QuoteData>>(() => {
    const m: Record<number, QuoteData> = {};
    for (const r of initialRows) if (r.quote) m[r.id] = r.quote as QuoteData;
    return m;
  });

  const [latestDate, setLatestDate]           = useState(initialDate);
  const [refreshState, setRefreshState]       = useState<BtnState>("idle");
  const [refreshAllState, setRefreshAllState] = useState<BtnState>("idle");
  const [countdown, setCountdown]             = useState(0);
  const [countdownAll, setCountdownAll]       = useState(0);
  const [searchQuery, setSearchQuery]         = useState("");
  const [filterGoldenCross, setFilterGoldenCross] = useState(false);
  const [statusFilter, setStatusFilter]       = useState<StatusFilter>("all");
  const [sortField, setSortField]             = useState<SortField>(null);
  const [sortDir, setSortDir]                 = useState<SortDir>("desc");

  // ── New feature state ──────────────────────────────────────────────────────
  // deletedCodes persisted in localStorage so deleted stocks stay hidden across
  // hard refreshes, back-navigation, and pipeline re-inserts
  const [deletedCodes, setDeletedCodes]       = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const stored = localStorage.getItem("watchlist_deleted_codes");
      return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch { return new Set(); }
  });
  const [deleteConfirm, setDeleteConfirm]     = useState<{ id: number; nse_code: string; name: string } | null>(null);
  const [deleteLoading, setDeleteLoading]     = useState(false);

  const [fy27Overrides, setFy27Overrides]     = useState<Record<string, number | null>>({});
  const [editingFy27, setEditingFy27]         = useState<string | null>(null);
  const [fy27EditVal, setFy27EditVal]         = useState("");

  const [notes, setNotes]                     = useState<Record<string, string>>({});
  const [statuses, setStatuses]               = useState<Record<string, StockStatus>>(() => {
    if (typeof window === "undefined") return {};
    const out: Record<string, StockStatus> = {};
    for (const row of initialRows) {
      const s = localStorage.getItem(`status_${row.nse_code}`);
      if (s === "invested" || s === "not_interested" || s === "on_radar") out[row.nse_code] = s;
    }
    return out;
  });
  const [notesModal, setNotesModal]           = useState<{ nse_code: string; name: string } | null>(null);
  const [notesEditText, setNotesEditText]     = useState("");
  const [notesEditStatus, setNotesEditStatus] = useState<StockStatus>("on_radar");
  const [noteTooltip, setNoteTooltip]         = useState<{ text: string; x: number; y: number } | null>(null);

  // ── Per-row refresh state ──────────────────────────────────────────────────
  const [rowRefreshState, setRowRefreshState]   = useState<Record<string, BtnState>>({});
  const rowRefreshTimers                         = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  // ── Add-stock modal state ──────────────────────────────────────────────────
  const [addModal, setAddModal]                 = useState(false);
  const [addForm, setAddForm]                   = useState({ nse_code: "", name: "", screener_url: "" });
  const [addLoading, setAddLoading]             = useState(false);
  const [addError, setAddError]                 = useState("");

  // Load persisted FY27 overrides and notes: localStorage first (instant), then Supabase sync
  useEffect(() => {
    // 1. Hydrate from localStorage immediately
    const overrides: Record<string, number | null> = {};
    const noteMap: Record<string, string> = {};
    for (const row of initialRows) {
      const ov = localStorage.getItem(`fy27_${row.nse_code}`);
      if (ov !== null) overrides[row.nse_code] = ov === "" ? null : parseFloat(ov);
      const note = localStorage.getItem(`note_${row.nse_code}`);
      if (note) noteMap[row.nse_code] = note;
    }
    if (Object.keys(overrides).length) setFy27Overrides(overrides);
    if (Object.keys(noteMap).length)   setNotes(noteMap);

    // 2. Sync from Supabase in background (server is source of truth)
    fetch("/api/notes")
      .then((r) => r.ok ? r.json() : null)
      .then((serverNotes: Record<string, string> | null) => {
        if (!serverNotes) return;
        // Merge: server wins; also refresh localStorage cache
        setNotes((prev) => {
          const merged = { ...prev, ...serverNotes };
          for (const [code, note] of Object.entries(serverNotes)) {
            if (note) localStorage.setItem(`note_${code}`, note);
            else localStorage.removeItem(`note_${code}`);
          }
          return merged;
        });
      })
      .catch(() => {/* table may not exist yet — silent fail */});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerAllRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const reloadQuotes = useCallback(async () => {
    const fresh = await fetchLatestQuotes(stockIds);
    setQuoteMap(fresh);
    const dates = Object.values(fresh).map((q) => q.date).filter(Boolean).sort().reverse();
    if (dates[0]) setLatestDate(dates[0] as string);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockIds.join(",")]);

  const reloadCmp = useCallback(async () => {
    const fresh = await fetchLatestCmp(stockIds);
    setQuoteMap((prev) => {
      const next = { ...prev };
      for (const [idStr, patch] of Object.entries(fresh)) {
        const id = Number(idStr);
        if (next[id]) next[id] = { ...next[id], ...patch };
      }
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockIds.join(",")]);

  useEffect(() => {
    // Always re-read Supabase on mount and every 5 min so data stays current
    reloadCmp();
    const id = setInterval(() => reloadCmp(), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [reloadCmp]);

  useEffect(() => () => {
    if (timerRef.current)    clearInterval(timerRef.current);
    if (timerAllRef.current) clearInterval(timerAllRef.current);
  }, []);

  const startCountdown = (
    totalSecs: number,
    setCount: (n: number) => void,
    timerRefObj: React.MutableRefObject<ReturnType<typeof setInterval> | null>,
    onDone: () => void
  ) => {
    setCount(totalSecs);
    const end = Date.now() + totalSecs * 1000;
    timerRefObj.current = setInterval(() => {
      const remaining = Math.max(0, Math.round((end - Date.now()) / 1000));
      setCount(remaining);
      if (remaining === 0) {
        clearInterval(timerRefObj.current!);
        timerRefObj.current = null;
        onDone();
      }
    }, 1000);
  };

  const handleRefresh = async () => {
    setRefreshState("triggering");
    // Immediately show latest already-in-Supabase data while pipeline runs
    reloadCmp();
    try {
      const res = await fetch("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "quick" }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRefreshState("waiting");
      startCountdown(QUICK_WAIT_S, setCountdown, timerRef, async () => { await reloadQuotes(); setRefreshState("done"); setTimeout(() => setRefreshState("idle"), 3000); });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      alert(`Refresh failed: ${msg}`);
      setRefreshState("error");
      setTimeout(() => setRefreshState("idle"), 3000);
    }
  };

  const handleRefreshAll = async () => {
    setRefreshAllState("triggering");
    reloadCmp();
    try {
      const res = await fetch("/api/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "all" }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRefreshAllState("waiting");
      startCountdown(ALL_WAIT_S, setCountdownAll, timerAllRef, () => { router.refresh(); setRefreshAllState("done"); setTimeout(() => setRefreshAllState("idle"), 3000); });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      alert(`Refresh failed: ${msg}`);
      setRefreshAllState("error");
      setTimeout(() => setRefreshAllState("idle"), 3000);
    }
  };

  const toggleSort = (field: "cmpDma50" | "volRatio") => {
    if (sortField !== field) { setSortField(field); setSortDir("desc"); }
    else if (sortDir === "desc") setSortDir("asc");
    else setSortField(null);
  };

  // ── Delete handlers ────────────────────────────────────────────────────────
  const handleDeleteConfirm = async () => {
    if (!deleteConfirm) return;
    setDeleteLoading(true);
    try {
      const res = await fetch("/api/delete-stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nse_code: deleteConfirm.nse_code }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setDeletedCodes((prev) => {
        const next = new Set(prev);
        next.add(deleteConfirm.nse_code);
        try { localStorage.setItem("watchlist_deleted_codes", JSON.stringify(Array.from(next))); } catch {}
        return next;
      });
      setDeleteConfirm(null);
      router.refresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      alert(`Delete failed: ${msg}\n\nPlease try again.`);
    } finally {
      setDeleteLoading(false);
    }
  };

  // ── FY27 edit handlers ─────────────────────────────────────────────────────
  const saveFy27 = (nse_code: string) => {
    const raw = fy27EditVal.trim().replace(/%/g, "");
    const val = raw === "" ? null : parseFloat(raw) / 100;
    setFy27Overrides((prev) => ({ ...prev, [nse_code]: val }));
    if (val === null) localStorage.removeItem(`fy27_${nse_code}`);
    else localStorage.setItem(`fy27_${nse_code}`, String(val));
    setEditingFy27(null);
  };

  const openFy27Edit = (nse_code: string, effective: number | null) => {
    setEditingFy27(nse_code);
    setFy27EditVal(effective != null ? String((effective * 100).toFixed(0)) : "");
  };

  // ── Notes + Status handlers ────────────────────────────────────────────────
  const openNotes = (row: RowData) => {
    setNotesModal({ nse_code: row.nse_code, name: row.name });
    setNotesEditText(notes[row.nse_code] ?? "");
    setNotesEditStatus(statuses[row.nse_code] ?? "on_radar");
  };

  const saveNotes = () => {
    if (!notesModal) return;
    const text = notesEditText.trim();
    const code = notesModal.nse_code;

    setNotes((prev) => ({ ...prev, [code]: text }));
    if (text === "") localStorage.removeItem(`note_${code}`);
    else localStorage.setItem(`note_${code}`, text);

    setStatuses((prev) => ({ ...prev, [code]: notesEditStatus }));
    localStorage.setItem(`status_${code}`, notesEditStatus);

    setNotesModal(null);

    fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nse_code: code, note: text }),
    }).catch(() => {});
  };

  // ── Per-row refresh handler ────────────────────────────────────────────────
  const handleRowRefresh = async (nse_code: string) => {
    setRowRefreshState((p) => ({ ...p, [nse_code]: "triggering" }));
    try {
      const res = await fetch("/api/refresh-stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nse_code }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRowRefreshState((p) => ({ ...p, [nse_code]: "waiting" }));
      let remaining = SINGLE_WAIT_S;
      rowRefreshTimers.current[nse_code] = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(rowRefreshTimers.current[nse_code]);
          reloadQuotes();
          setRowRefreshState((p) => ({ ...p, [nse_code]: "done" }));
          setTimeout(() => setRowRefreshState((p) => ({ ...p, [nse_code]: "idle" })), 3000);
        }
      }, 1000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      alert(`Refresh failed: ${msg}`);
      setRowRefreshState((p) => ({ ...p, [nse_code]: "error" }));
      setTimeout(() => setRowRefreshState((p) => ({ ...p, [nse_code]: "idle" })), 3000);
    }
  };

  // ── Add-stock handler ──────────────────────────────────────────────────────
  const handleAddStock = async () => {
    const { nse_code, name, screener_url } = addForm;
    if (!nse_code.trim() || !name.trim()) { setAddError("NSE Code and Name are required."); return; }
    setAddLoading(true);
    setAddError("");
    try {
      const res = await fetch("/api/add-stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nse_code: nse_code.trim().toUpperCase(), name: name.trim(), screener_url: screener_url.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setAddModal(false);
      setAddForm({ nse_code: "", name: "", screener_url: "" });
      router.refresh();
    } catch (err: unknown) {
      setAddError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setAddLoading(false);
    }
  };

  // ── Filtered + sorted rows ────────────────────────────────────────────────
  const displayRows = useMemo(() => {
    let rows = initialRows.filter((r) => !deletedCodes.has(r.nse_code));

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter((r) => r.nse_code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
    }

    if (statusFilter !== "all") {
      rows = rows.filter((r) => (statuses[r.nse_code] ?? "on_radar") === statusFilter);
    }

    if (filterGoldenCross) {
      rows = rows.filter((r) => {
        const q = quoteMap[r.id];
        return q?.dma_50 != null && q?.dma_200 != null && Number(q.dma_50) > Number(q.dma_200);
      });
    }

    if (sortField) {
      rows = [...rows].sort((a, b) => {
        let av: number | null = null, bv: number | null = null;
        if (sortField === "cmpDma50") {
          av = cmpVsDma50Val(quoteMap[a.id] ?? null);
          bv = cmpVsDma50Val(quoteMap[b.id] ?? null);
        } else {
          const qa = quoteMap[a.id], qb = quoteMap[b.id];
          av = qa ? volRatio(qa.volume_7d, qa.avg_volume_30d) : null;
          bv = qb ? volRatio(qb.volume_7d, qb.avg_volume_30d) : null;
        }
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return sortDir === "asc" ? av - bv : bv - av;
      });
    }

    return rows;
  }, [initialRows, deletedCodes, searchQuery, statusFilter, statuses, filterGoldenCross, sortField, sortDir, quoteMap]);

  const activeCount = initialRows.filter((r) => !deletedCodes.has(r.nse_code)).length;

  return (
    <div>
      {/* ── Header ── */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h1 className="text-xl font-semibold">Watchlist</h1>
        <RefreshBtn state={refreshState} countdown={countdown} onClick={handleRefresh} label="↻ Refresh" />
        <RefreshBtn state={refreshAllState} countdown={countdownAll} onClick={handleRefreshAll} label="↻ Refresh All" />
        <span className="ml-auto text-xs text-gray-400">
          {activeCount} stocks · as of {latestDate}
        </span>
        <button
          onClick={() => { setAddModal(true); setAddError(""); }}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
        >
          + Add Stock
        </button>
      </div>

      {/* ── Controls bar ── */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <input
          type="text"
          placeholder="Search stock…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="bg-white border border-gray-300 text-gray-800 text-xs rounded px-3 py-1.5 w-44 placeholder-gray-400 focus:outline-none focus:border-gray-500"
        />
        {/* Status filter tabs */}
        <div className="flex gap-1">
          {(["all", "on_radar", "invested", "not_interested"] as const).map((s) => {
            const label = s === "all" ? "All" : STATUS_LABELS[s];
            const active = statusFilter === s;
            const cls = s === "all"
              ? active ? "bg-gray-700 text-white border-gray-700" : "bg-white border-gray-300 text-gray-500 hover:border-gray-500"
              : s === "on_radar"
              ? active ? "bg-blue-600 text-white border-blue-600" : "bg-white border-gray-300 text-gray-500 hover:border-blue-400"
              : s === "invested"
              ? active ? "bg-emerald-600 text-white border-emerald-600" : "bg-white border-gray-300 text-gray-500 hover:border-emerald-400"
              : active ? "bg-gray-500 text-white border-gray-500" : "bg-white border-gray-300 text-gray-500 hover:border-gray-400";
            return (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`px-2.5 py-1.5 rounded text-xs font-medium border transition-colors ${cls}`}>
                {label}
              </button>
            );
          })}
        </div>
        <button
          onClick={() => setFilterGoldenCross((v) => !v)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
            filterGoldenCross ? "bg-emerald-50 border-emerald-400 text-emerald-700" : "bg-white border-gray-300 text-gray-500 hover:border-gray-400"
          }`}
        >
          <span className={filterGoldenCross ? "text-emerald-600" : "text-gray-400"}>▲</span>
          50 DMA &gt; 200 DMA
        </button>
        {(searchQuery || statusFilter !== "all" || filterGoldenCross || sortField) && (
          <span className="text-xs text-gray-500">{displayRows.length} of {activeCount} shown</span>
        )}
      </div>

      {/* ── Table ── */}
      <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-12rem)] rounded-lg border border-gray-200">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-gray-100 border-b border-gray-200 text-gray-500 text-xs uppercase tracking-wide">
              <th className="py-3 px-4 text-left bg-gray-100">Stock</th>
              <th className="px-3 text-left bg-gray-100">Sector</th>
              <th className="px-3 text-right bg-gray-100">CMP</th>
              <th className="px-3 text-right bg-gray-100">PE</th>
              <th className="px-3 text-right bg-gray-100">Ind PE</th>
              <th className="px-3 text-right bg-gray-100">Revenue<br /><span className="text-gray-400 normal-case">FY26 Cr</span></th>
              <th className="px-3 text-right bg-gray-100">Rev Growth<br /><span className="text-gray-400 normal-case">YoY %</span></th>
              <th className="px-3 text-right bg-gray-100">Net Profit<br /><span className="text-gray-400 normal-case">FY26 Cr</span></th>
              <th className="px-3 text-right bg-gray-100">NP Growth<br /><span className="text-gray-400 normal-case">YoY %</span></th>
              <th className="px-3 text-right bg-gray-100 select-none" title="Double-click any cell to edit">
                FY27 Guide<br /><span className="text-gray-400 normal-case font-normal">Rev % ✎</span>
              </th>
              <th className="px-3 text-right bg-gray-100">200 DMA</th>
              <th className="px-3 text-right bg-gray-100">50 DMA</th>
              <th className="px-3 text-right bg-gray-100 cursor-pointer hover:text-gray-700 select-none" onClick={() => toggleSort("cmpDma50")}>
                <div className="flex items-center justify-end gap-1">CMP/DMA-50 <SortArrows field="cmpDma50" sortField={sortField} sortDir={sortDir} /></div>
                <span className="text-gray-400 normal-case font-normal">% diff</span>
              </th>
              <th className="px-3 text-right bg-gray-100 cursor-pointer hover:text-gray-700 select-none" onClick={() => toggleSort("volRatio")}>
                <div className="flex items-center justify-end gap-1">Vol Ratio <SortArrows field="volRatio" sortField={sortField} sortDir={sortDir} /></div>
                <span className="text-gray-400 normal-case font-normal">7d/30d</span>
              </th>
              <th className="px-3 text-center bg-gray-100 w-20">Actions</th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => {
              const q          = quoteMap[row.id] ?? null;
              const fy26       = row.fy26Complete ? row.funds["FY26"] : null;
              const fy25       = row.funds["FY25"];
              const rev        = fy26?.revenue    ?? null;
              const np         = fy26?.net_profit ?? null;
              const revGrowth  = yoy(rev, fy25?.revenue    ?? null);
              const npGrowth   = yoy(np,  fy25?.net_profit ?? null);
              const vRatio     = q ? volRatio(q.volume_7d, q.avg_volume_30d) : null;
              const cmpDma50   = cmpVsDma50Val(q);
              const hasEvent   = stocksWithEvents.has(row.id);
              const rowNote    = notes[row.nse_code];
              const rowStatus  = statuses[row.nse_code] ?? "on_radar";

              const dma200Color = q?.cmp && q?.dma_200
                ? Number(q.cmp) > Number(q.dma_200) ? "text-emerald-600" : "text-red-500"
                : "text-gray-400";
              const dma50Color = q?.cmp && q?.dma_50
                ? Number(q.cmp) > Number(q.dma_50) ? "text-emerald-600" : "text-red-500"
                : "text-gray-400";

              const effectiveFy27 = fy27Overrides[row.nse_code] !== undefined
                ? fy27Overrides[row.nse_code]
                : row.fy27Guidance;

              return (
                <tr key={row.id} className="border-b border-gray-200 hover:bg-blue-50 transition-colors">
                  {/* Stock name */}
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-1.5">
                      <Link href={`/stock/${row.nse_code}`} className="text-blue-600 hover:text-blue-800 font-semibold text-sm">
                        {row.nse_code}
                      </Link>
                      <a href={`https://www.screener.in/company/${screenerCode(row.nse_code)}/consolidated/`} target="_blank" rel="noopener noreferrer" title="Open on Screener.in" className="flex items-center">
                        <ExternalLinkIcon />
                      </a>
                      {rowStatus !== "on_radar" && (
                        <span
                          className={`inline-block w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[rowStatus]}`}
                          title={STATUS_LABELS[rowStatus]}
                        />
                      )}
                      {hasEvent && (
                        <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 shrink-0" title="New event today" />
                      )}
                      {/* Note hover icon — tooltip rendered fixed to escape overflow clipping */}
                      {rowNote && (
                        <span
                          className="cursor-default shrink-0"
                          onMouseEnter={(e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            setNoteTooltip({ text: rowNote, x: r.left, y: r.bottom + 6 });
                          }}
                          onMouseLeave={() => setNoteTooltip(null)}
                        >
                          <NoteIcon className="w-3 h-3 text-blue-400" />
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5 max-w-[160px] truncate">{row.name}</div>
                  </td>

                  {/* Sector */}
                  <td className="px-3">
                    <div className="text-gray-700 text-xs">{row.sector}</div>
                    {row.market_cap_bucket && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded mt-0.5 inline-block ${CAP_STYLE[row.market_cap_bucket] ?? ""}`}>
                        {row.market_cap_bucket}
                      </span>
                    )}
                  </td>

                  {/* CMP */}
                  <td className="px-3 text-right">
                    <div className="text-gray-900 font-medium">{q?.cmp != null ? fmt(Number(q.cmp), 1) : "—"}</div>
                    <div className={`text-xs ${cmpPctColor(q?.pct_change != null ? Number(q.pct_change) : null)}`}>
                      {q?.pct_change != null ? pctFmt(Number(q.pct_change)) : ""}
                    </div>
                  </td>

                  {/* PE / Ind PE */}
                  <td className="px-3 text-right text-gray-700">{q?.pe != null ? Number(q.pe).toFixed(1) : "—"}</td>
                  <td className="px-3 text-right text-gray-500">{q?.sector_pe != null ? Number(q.sector_pe).toFixed(1) : "—"}</td>

                  {/* Revenue */}
                  <td className="px-3 text-right">
                    {rev != null ? <span className="text-gray-700">{fmt(Number(rev))}</span> : <span className="text-yellow-600 text-xs italic">Awaited</span>}
                  </td>
                  <td className={`px-3 text-right ${rev != null ? pctColor(revGrowth) : "text-gray-400"}`}>
                    {rev != null ? (revGrowth != null ? pctFmt(revGrowth) : "—") : "—"}
                  </td>

                  {/* Net Profit */}
                  <td className="px-3 text-right">
                    {np != null ? <span className="text-gray-700">{fmt(Number(np))}</span> : <span className="text-yellow-600 text-xs italic">Awaited</span>}
                  </td>
                  <td className={`px-3 text-right ${np != null ? pctColor(npGrowth) : "text-gray-400"}`}>
                    {np != null ? (npGrowth != null ? pctFmt(npGrowth) : "—") : "—"}
                  </td>

                  {/* FY27 Guidance — double-click to edit */}
                  <td
                    className="px-3 text-right cursor-pointer select-none"
                    title={editingFy27 !== row.nse_code ? (row.fy27Remarks ?? "Double-click to edit") : undefined}
                    onDoubleClick={() => openFy27Edit(row.nse_code, effectiveFy27)}
                  >
                    {editingFy27 === row.nse_code ? (
                      <input
                        autoFocus
                        className="w-14 text-right text-xs border border-blue-400 rounded px-1 py-0.5 bg-white text-gray-900 focus:outline-none"
                        value={fy27EditVal}
                        placeholder="%"
                        onChange={(e) => setFy27EditVal(e.target.value)}
                        onBlur={() => saveFy27(row.nse_code)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveFy27(row.nse_code);
                          if (e.key === "Escape") setEditingFy27(null);
                        }}
                      />
                    ) : (
                      <span className={fy27GuideColor(effectiveFy27)}>
                        {effectiveFy27 != null ? `+${(effectiveFy27 * 100).toFixed(0)}%` : "—"}
                      </span>
                    )}
                  </td>

                  {/* 200 DMA / 50 DMA */}
                  <td className="px-3 text-right">
                    <span className={dma200Color}>{q?.dma_200 != null ? fmt(Number(q.dma_200)) : "—"}</span>
                  </td>
                  <td className="px-3 text-right">
                    <span className={dma50Color}>{q?.dma_50 != null ? fmt(Number(q.dma_50)) : "—"}</span>
                    {q?.dma_50 != null && q?.dma_200 != null &&
                      Math.abs(Number(q.dma_50) - Number(q.dma_200)) / Number(q.dma_200) <= 0.02 && (
                        <span className="ml-1 text-yellow-500" title="DMA-50 within 2% of DMA-200">★</span>
                    )}
                  </td>

                  {/* CMP/DMA-50 % diff */}
                  <td className={`px-3 text-right font-medium ${cmpDmaColor(cmpDma50)}`}>
                    {cmpDma50 != null ? pctFmt(cmpDma50) : "—"}
                  </td>

                  {/* Vol Ratio */}
                  <td className={`px-3 text-right font-medium ${volRatioColor(vRatio)}`}>
                    {vRatio != null ? vRatio.toFixed(2) + "×" : "—"}
                  </td>

                  {/* Actions */}
                  <td className="px-3 text-center">
                    <div className="flex items-center justify-center gap-2">
                      <button
                        onClick={() => openNotes(row)}
                        title="Add / edit notes"
                        className={`p-1 rounded transition-colors ${rowNote ? "text-blue-500 hover:text-blue-700" : "text-gray-300 hover:text-blue-500"}`}
                      >
                        <NoteIcon className="w-3.5 h-3.5" />
                      </button>
                      {/* Per-stock refresh */}
                      {(() => {
                        const rs = rowRefreshState[row.nse_code] ?? "idle";
                        const busy = rs === "triggering" || rs === "waiting";
                        return (
                          <button
                            onClick={() => !busy && handleRowRefresh(row.nse_code)}
                            title={rs === "done" ? "Refreshed!" : rs === "waiting" ? "Refreshing…" : `Refresh ${row.nse_code}`}
                            disabled={busy}
                            className={`p-1 rounded transition-colors ${
                              rs === "done"    ? "text-emerald-500" :
                              rs === "error"   ? "text-red-400" :
                              busy             ? "text-blue-300 cursor-not-allowed" :
                              "text-gray-300 hover:text-blue-500"
                            }`}
                          >
                            {busy
                              ? <span className="inline-block w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                              : <RefreshRowIcon className="w-3.5 h-3.5" />
                            }
                          </button>
                        );
                      })()}
                      <button
                        onClick={() => setDeleteConfirm({ id: row.id, nse_code: row.nse_code, name: row.name })}
                        title="Remove from watchlist"
                        className="p-1 rounded text-gray-300 hover:text-red-500 transition-colors"
                      >
                        <TrashIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Legend ── */}
      <div className="mt-3 flex gap-6 text-xs text-gray-500 flex-wrap">
        <span>DMA-200/50: <span className="text-emerald-600">green</span>=CMP above · <span className="text-red-500">red</span>=CMP below · <span className="text-yellow-500">★</span>=DMA-50 within 2% of DMA-200</span>
        <span>Rev/NP growth: <span className="text-emerald-600">≥20%</span> · <span className="text-orange-500">0-10%</span> · <span className="text-red-500">negative</span></span>
        <span>CMP/DMA-50: <span className="text-emerald-600">+ve</span>=above · <span className="text-red-500">-ve</span>=below</span>
        <span>Vol ratio: <span className="text-emerald-600">≥1.5×</span> elevated · <span className="text-red-500">≤0.7×</span> suppressed</span>
        <span className="ml-auto text-gray-400 italic">CMP auto-refreshes every 5 min</span>
      </div>

      {/* ── Delete confirmation modal ── */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !deleteLoading && setDeleteConfirm(null)}>
          <div className="bg-white rounded-lg border border-gray-200 shadow-xl p-5 w-80" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Remove from watchlist?</h3>
            <p className="text-xs text-gray-600 mb-1">
              <strong className="text-gray-900">{deleteConfirm.nse_code}</strong> — {deleteConfirm.name}
            </p>
            <p className="text-xs text-red-500 mb-4">This will delete all data for this stock from Supabase.</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                disabled={deleteLoading}
                className="px-3 py-1.5 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={deleteLoading}
                className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                {deleteLoading ? <><Spinner /> Deleting…</> : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Note hover tooltip (fixed — escapes overflow clipping) ── */}
      {noteTooltip && (
        <div
          className="fixed z-50 bg-white border border-gray-300 rounded-lg shadow-xl p-3 text-xs text-gray-800 whitespace-pre-wrap leading-relaxed pointer-events-none"
          style={{ left: noteTooltip.x, top: noteTooltip.y, maxWidth: 320, minWidth: 200 }}
        >
          {noteTooltip.text}
        </div>
      )}

      {/* ── Notes modal ── */}
      {notesModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setNotesModal(null)}>
          <div className="bg-white rounded-lg border border-gray-200 shadow-xl p-5 w-[36rem]" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-0.5">Notes &amp; Status</h3>
            <p className="text-xs text-gray-500 mb-3">{notesModal.nse_code} · {notesModal.name}</p>

            {/* Status radio */}
            <div className="mb-3">
              <div className="text-xs text-gray-500 mb-1.5 font-medium">Status</div>
              <div className="flex gap-2">
                {(["on_radar", "invested", "not_interested"] as const).map((s) => {
                  const active = notesEditStatus === s;
                  const cls = s === "on_radar"
                    ? active ? "border-blue-500 bg-blue-50 text-blue-700 font-medium" : "border-gray-200 text-gray-500 hover:border-blue-300"
                    : s === "invested"
                    ? active ? "border-emerald-500 bg-emerald-50 text-emerald-700 font-medium" : "border-gray-200 text-gray-500 hover:border-emerald-300"
                    : active ? "border-gray-400 bg-gray-100 text-gray-600 font-medium" : "border-gray-200 text-gray-500 hover:border-gray-300";
                  return (
                    <button key={s} onClick={() => setNotesEditStatus(s)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs transition-colors ${cls}`}>
                      <span className={`w-2 h-2 rounded-full ${active ? STATUS_DOT[s] : "bg-gray-300"}`} />
                      {STATUS_LABELS[s]}
                    </button>
                  );
                })}
              </div>
            </div>

            <textarea
              autoFocus
              className="w-full h-48 text-xs border border-gray-300 rounded p-2.5 resize-y focus:outline-none focus:border-blue-400 text-gray-800 placeholder-gray-400"
              placeholder="Add your notes about this stock…"
              value={notesEditText}
              onChange={(e) => setNotesEditText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && e.metaKey) saveNotes(); }}
            />
            <p className="text-[10px] text-gray-400 mt-1 mb-3">⌘+Enter to save</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setNotesModal(null)}
                className="px-3 py-1.5 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              {notes[notesModal.nse_code] && (
                <button
                  onClick={() => {
                    const code = notesModal.nse_code;
                    setNotes((prev) => { const n = { ...prev }; delete n[code]; return n; });
                    localStorage.removeItem(`note_${code}`);
                    setNotesModal(null);
                    fetch("/api/notes", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ nse_code: code, note: "" }),
                    }).catch(() => {});
                  }}
                  className="px-3 py-1.5 text-xs rounded border border-red-200 text-red-600 hover:bg-red-50"
                >
                  Clear Note
                </button>
              )}
              <button
                onClick={saveNotes}
                className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Stock modal ── */}
      {addModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => !addLoading && setAddModal(false)}>
          <div className="bg-white rounded-lg border border-gray-200 shadow-xl p-5 w-[28rem]" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-4">Add Stock to Watchlist</h3>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 font-medium block mb-1">NSE Code <span className="text-red-400">*</span></label>
                <input
                  autoFocus
                  className="w-full text-xs border border-gray-300 rounded px-2.5 py-1.5 focus:outline-none focus:border-blue-400 text-gray-900 uppercase placeholder-gray-400"
                  placeholder="e.g. ZAGGLE"
                  value={addForm.nse_code}
                  onChange={(e) => setAddForm((p) => ({ ...p, nse_code: e.target.value.toUpperCase() }))}
                />
              </div>

              <div>
                <label className="text-xs text-gray-500 font-medium block mb-1">Company Name <span className="text-red-400">*</span></label>
                <input
                  className="w-full text-xs border border-gray-300 rounded px-2.5 py-1.5 focus:outline-none focus:border-blue-400 text-gray-900 placeholder-gray-400"
                  placeholder="e.g. Zaggle Prepaid Ocean Services Ltd"
                  value={addForm.name}
                  onChange={(e) => setAddForm((p) => ({ ...p, name: e.target.value }))}
                />
              </div>

              <div>
                <label className="text-xs text-gray-500 font-medium block mb-1">Screener URL</label>
                <input
                  className="w-full text-xs border border-gray-300 rounded px-2.5 py-1.5 focus:outline-none focus:border-blue-400 text-gray-900 placeholder-gray-400"
                  placeholder="https://www.screener.in/company/ZAGGLE/consolidated/"
                  value={addForm.screener_url}
                  onChange={(e) => setAddForm((p) => ({ ...p, screener_url: e.target.value }))}
                />
              </div>
            </div>

            {addError && <p className="text-xs text-red-500 mt-2">{addError}</p>}

            <p className="text-[10px] text-gray-400 mt-3">
              Stock will be added to Supabase + watchlist.yaml and a pipeline run will start (~5 min to populate data).
            </p>

            <div className="flex gap-2 justify-end mt-3">
              <button
                onClick={() => setAddModal(false)}
                disabled={addLoading}
                className="px-3 py-1.5 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleAddStock}
                disabled={addLoading}
                className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                {addLoading ? <><span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</> : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
