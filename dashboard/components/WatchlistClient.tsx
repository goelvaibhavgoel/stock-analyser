"use client";

import { createClient } from "@supabase/supabase-js";
import Link from "next/link";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";

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
};

type SortField = "cmpDma50" | "volRatio" | null;
type SortDir   = "asc" | "desc";

// ── Color helpers ─────────────────────────────────────────────────────────────
const CAP_STYLE: Record<string, string> = {
  LARGE: "bg-blue-900/50 text-blue-300",
  MID:   "bg-purple-900/50 text-purple-300",
  SMALL: "bg-orange-900/50 text-orange-300",
};

function pctColor(v: number | null) {
  if (v == null) return "text-gray-500";
  if (v >= 20) return "text-emerald-400 font-semibold";
  if (v >= 10) return "text-emerald-500";
  if (v > 0)   return "text-gray-300";
  if (v < -10) return "text-red-400";
  return "text-orange-400";
}

function cmpPctColor(v: number | null) {
  if (v == null) return "text-gray-500";
  if (v > 0)    return "text-emerald-400";
  if (v < 0)    return "text-red-400";
  return "text-gray-400";
}

function volRatioColor(r: number | null) {
  if (r == null) return "text-gray-500";
  if (r > 1.5)  return "text-emerald-400";
  if (r > 1.0)  return "text-yellow-400";
  if (r < 0.7)  return "text-red-400";
  return "text-gray-300";
}

function cmpDmaColor(v: number | null) {
  if (v == null) return "text-gray-500";
  if (v > 5)    return "text-emerald-400";
  if (v > 0)    return "text-emerald-600";
  if (v < -5)   return "text-red-400";
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

// ── Small icons ───────────────────────────────────────────────────────────────
function ExternalLinkIcon() {
  return (
    <svg
      className="inline w-2.5 h-2.5 shrink-0 text-gray-600 hover:text-gray-300 transition-colors"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
      />
    </svg>
  );
}

function SortArrows({
  field,
  sortField,
  sortDir,
}: {
  field: SortField;
  sortField: SortField;
  sortDir: SortDir;
}) {
  if (sortField !== field) {
    return <span className="text-gray-700 leading-none">↕</span>;
  }
  return (
    <span className="text-blue-400 leading-none">
      {sortDir === "asc" ? "↑" : "↓"}
    </span>
  );
}

// ── Market-hours guard (IST = UTC+5:30, Mon–Fri 9:15–16:00) ─────────────────
function isMarketHours(): boolean {
  const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const day = nowIST.getUTCDay(); // 0=Sun … 6=Sat
  if (day === 0 || day === 6) return false;
  const mins = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins < 16 * 60;
}

// ── Fetch latest quotes from Supabase ─────────────────────────────────────────
async function fetchLatestQuotes(stockIds: number[]): Promise<Record<number, QuoteData>> {
  const { data } = await supabase
    .from("daily_quotes")
    .select("stock_id,date,cmp,pct_change,pe,sector_pe,dma_50,dma_200,volume_7d,avg_volume_30d")
    .in("stock_id", stockIds)
    .order("date", { ascending: false })
    .limit(stockIds.length * 3);

  const map: Record<number, QuoteData> = {};
  for (const q of (data ?? []) as QuoteData[]) {
    if (!map[q.stock_id]) map[q.stock_id] = q;
  }
  return map;
}

// CMP-only fetch — does NOT touch PE or any other field
async function fetchLatestCmp(
  stockIds: number[]
): Promise<Record<number, { cmp: number | null; pct_change: number | null }>> {
  const { data } = await supabase
    .from("daily_quotes")
    .select("stock_id,cmp,pct_change")
    .in("stock_id", stockIds)
    .order("date", { ascending: false })
    .limit(stockIds.length * 3);

  const map: Record<number, { cmp: number | null; pct_change: number | null }> = {};
  for (const q of (data ?? []) as any[]) {
    if (!map[q.stock_id]) map[q.stock_id] = { cmp: q.cmp, pct_change: q.pct_change };
  }
  return map;
}

// ── Button state ──────────────────────────────────────────────────────────────
type BtnState = "idle" | "triggering" | "waiting" | "done" | "error";

const QUICK_WAIT_S = 90;
const ALL_WAIT_S   = 8 * 60;
const AUTO_REFRESH_MS = 60 * 60 * 1000; // 1 hour (only fires during market hours)

function Spinner() {
  return (
    <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
  );
}

function RefreshBtn({
  state,
  countdown,
  onClick,
  label,
}: {
  state: BtnState;
  countdown: number;
  onClick: () => void;
  label: string;
}) {
  const busy = state !== "idle" && state !== "done" && state !== "error";
  const baseClass =
    "inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors select-none";

  let colorClass =
    "bg-gray-800 border border-gray-600 hover:border-gray-400 text-gray-300 cursor-pointer";
  if (busy)             colorClass = "bg-gray-800 border border-gray-700 text-gray-500 cursor-not-allowed";
  if (state === "done") colorClass = "bg-emerald-900/60 border border-emerald-700 text-emerald-300 cursor-not-allowed";
  if (state === "error") colorClass = "bg-red-900/60 border border-red-700 text-red-300 cursor-not-allowed";

  return (
    <button onClick={onClick} disabled={busy} className={`${baseClass} ${colorClass}`}>
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
    for (const r of initialRows) {
      if (r.quote) m[r.id] = r.quote as QuoteData;
    }
    return m;
  });

  const [latestDate, setLatestDate]             = useState(initialDate);
  const [refreshState, setRefreshState]         = useState<BtnState>("idle");
  const [refreshAllState, setRefreshAllState]   = useState<BtnState>("idle");
  const [countdown, setCountdown]               = useState(0);
  const [countdownAll, setCountdownAll]         = useState(0);

  // ── Controls state ────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery]           = useState("");
  const [filterGoldenCross, setFilterGoldenCross] = useState(false);
  const [sortField, setSortField]               = useState<SortField>(null);
  const [sortDir, setSortDir]                   = useState<SortDir>("desc");

  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerAllRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Full reload (used by Refresh / Refresh All buttons)
  const reloadQuotes = useCallback(async () => {
    const fresh = await fetchLatestQuotes(stockIds);
    setQuoteMap(fresh);
    const dates = Object.values(fresh)
      .map((q) => q.date)
      .filter(Boolean)
      .sort()
      .reverse();
    if (dates[0]) setLatestDate(dates[0] as string);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockIds.join(",")]);

  // CMP-only reload — runs hourly during market hours, never touches PE
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

  // Auto-refresh CMP every hour, Mon–Fri 9:15 AM–4:00 PM IST only
  useEffect(() => {
    const id = setInterval(() => {
      if (isMarketHours()) reloadCmp();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [reloadCmp]);

  useEffect(() => {
    return () => {
      if (timerRef.current)    clearInterval(timerRef.current);
      if (timerAllRef.current) clearInterval(timerAllRef.current);
    };
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
    try {
      const res = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "quick" }),
      });
      if (!res.ok) throw new Error();
      setRefreshState("waiting");
      startCountdown(QUICK_WAIT_S, setCountdown, timerRef, async () => {
        await reloadQuotes();
        setRefreshState("done");
        setTimeout(() => setRefreshState("idle"), 3000);
      });
    } catch {
      setRefreshState("error");
      setTimeout(() => setRefreshState("idle"), 3000);
    }
  };

  const handleRefreshAll = async () => {
    setRefreshAllState("triggering");
    try {
      const res = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "all" }),
      });
      if (!res.ok) throw new Error();
      setRefreshAllState("waiting");
      startCountdown(ALL_WAIT_S, setCountdownAll, timerAllRef, () => {
        router.refresh();
        setRefreshAllState("done");
        setTimeout(() => setRefreshAllState("idle"), 3000);
      });
    } catch {
      setRefreshAllState("error");
      setTimeout(() => setRefreshAllState("idle"), 3000);
    }
  };

  const toggleSort = (field: "cmpDma50" | "volRatio") => {
    if (sortField !== field) {
      setSortField(field);
      setSortDir("desc");
    } else if (sortDir === "desc") {
      setSortDir("asc");
    } else {
      setSortField(null);
    }
  };

  // ── Filtered + sorted rows ────────────────────────────────────────────────
  const displayRows = useMemo(() => {
    let rows = initialRows;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.nse_code.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q)
      );
    }

    if (filterGoldenCross) {
      rows = rows.filter((r) => {
        const q = quoteMap[r.id];
        return (
          q?.dma_50 != null &&
          q?.dma_200 != null &&
          Number(q.dma_50) > Number(q.dma_200)
        );
      });
    }

    if (sortField) {
      rows = [...rows].sort((a, b) => {
        let av: number | null = null;
        let bv: number | null = null;
        if (sortField === "cmpDma50") {
          av = cmpVsDma50Val(quoteMap[a.id] ?? null);
          bv = cmpVsDma50Val(quoteMap[b.id] ?? null);
        } else {
          const qa = quoteMap[a.id];
          const qb = quoteMap[b.id];
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
  }, [initialRows, searchQuery, filterGoldenCross, sortField, sortDir, quoteMap]);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h1 className="text-xl font-semibold">Watchlist</h1>
        <RefreshBtn state={refreshState} countdown={countdown} onClick={handleRefresh} label="↻ Refresh" />
        <RefreshBtn state={refreshAllState} countdown={countdownAll} onClick={handleRefreshAll} label="↻ Refresh All" />
        <span className="ml-auto text-xs text-gray-500">
          {initialRows.length} stocks · as of {latestDate}
        </span>
      </div>

      {/* Controls bar */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <input
          type="text"
          placeholder="Search stock…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="bg-gray-900 border border-gray-700 text-gray-200 text-xs rounded px-3 py-1.5 w-44 placeholder-gray-600 focus:outline-none focus:border-gray-500"
        />
        <button
          onClick={() => setFilterGoldenCross((v) => !v)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
            filterGoldenCross
              ? "bg-emerald-900/50 border-emerald-600 text-emerald-300"
              : "bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500"
          }`}
        >
          <span className={filterGoldenCross ? "text-emerald-400" : "text-gray-600"}>▲</span>
          50 DMA &gt; 200 DMA
        </button>
        {(searchQuery || filterGoldenCross || sortField) && (
          <span className="text-xs text-gray-500">
            {displayRows.length} of {initialRows.length} shown
          </span>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-12rem)] rounded-lg border border-gray-800">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-gray-900 border-b border-gray-700 text-gray-400 text-xs uppercase tracking-wide">
              <th className="py-3 px-4 text-left bg-gray-900">Stock</th>
              <th className="px-3 text-left bg-gray-900">Sector</th>
              <th className="px-3 text-right bg-gray-900">CMP</th>
              <th className="px-3 text-right bg-gray-900">PE</th>
              <th className="px-3 text-right bg-gray-900">Ind PE</th>
              <th className="px-3 text-right bg-gray-900">
                Revenue<br /><span className="text-gray-600 normal-case">FY26 Cr</span>
              </th>
              <th className="px-3 text-right bg-gray-900">
                Rev Growth<br /><span className="text-gray-600 normal-case">YoY %</span>
              </th>
              <th className="px-3 text-right bg-gray-900">
                Net Profit<br /><span className="text-gray-600 normal-case">FY26 Cr</span>
              </th>
              <th className="px-3 text-right bg-gray-900">
                NP Growth<br /><span className="text-gray-600 normal-case">YoY %</span>
              </th>
              <th className="px-3 text-right bg-gray-900">200 DMA</th>
              <th className="px-3 text-right bg-gray-900">50 DMA</th>
              <th
                className="px-3 text-right bg-gray-900 cursor-pointer hover:text-gray-200 select-none"
                onClick={() => toggleSort("cmpDma50")}
              >
                <div className="flex items-center justify-end gap-1">
                  CMP/DMA-50
                  <SortArrows field="cmpDma50" sortField={sortField} sortDir={sortDir} />
                </div>
                <span className="text-gray-600 normal-case font-normal">% diff</span>
              </th>
              <th
                className="px-4 text-right bg-gray-900 cursor-pointer hover:text-gray-200 select-none"
                onClick={() => toggleSort("volRatio")}
              >
                <div className="flex items-center justify-end gap-1">
                  Vol Ratio
                  <SortArrows field="volRatio" sortField={sortField} sortDir={sortDir} />
                </div>
                <span className="text-gray-600 normal-case font-normal">7d/30d</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => {
              const q         = quoteMap[row.id] ?? null;
              const fy26      = row.fy26Complete ? row.funds["FY26"] : null;
              const fy25      = row.funds["FY25"];
              const rev       = fy26?.revenue    ?? null;
              const np        = fy26?.net_profit ?? null;
              const revGrowth = yoy(rev, fy25?.revenue    ?? null);
              const npGrowth  = yoy(np,  fy25?.net_profit ?? null);
              const vRatio    = q ? volRatio(q.volume_7d, q.avg_volume_30d) : null;
              const cmpDma50  = cmpVsDma50Val(q);

              const dma200Color = q?.cmp && q?.dma_200
                ? Number(q.cmp) > Number(q.dma_200) ? "text-emerald-400" : "text-red-400"
                : "text-gray-400";
              const dma50Color = q?.cmp && q?.dma_50
                ? Number(q.cmp) > Number(q.dma_50) ? "text-emerald-400" : "text-red-400"
                : "text-gray-400";

              const hasEvent = stocksWithEvents.has(row.id);

              return (
                <tr
                  key={row.id}
                  className="border-b border-gray-800 hover:bg-gray-900/60 transition-colors"
                >
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-1.5">
                      <Link
                        href={`/stock/${row.nse_code}`}
                        className="text-blue-400 hover:text-blue-200 font-semibold text-sm"
                      >
                        {row.nse_code}
                      </Link>
                      <a
                        href={`https://www.screener.in/company/${row.nse_code}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open on Screener.in"
                        className="flex items-center"
                      >
                        <ExternalLinkIcon />
                      </a>
                      {hasEvent && (
                        <span
                          className="inline-block w-2 h-2 rounded-full bg-emerald-400 shrink-0"
                          title="New event today"
                        />
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5 max-w-[160px] truncate">
                      {row.name}
                    </div>
                  </td>
                  <td className="px-3">
                    <div className="text-gray-300 text-xs">{row.sector}</div>
                    {row.market_cap_bucket && (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded mt-0.5 inline-block ${CAP_STYLE[row.market_cap_bucket] ?? ""}`}
                      >
                        {row.market_cap_bucket}
                      </span>
                    )}
                  </td>
                  <td className="px-3 text-right">
                    <div className="text-white font-medium">
                      {q?.cmp != null ? fmt(Number(q.cmp), 1) : "—"}
                    </div>
                    <div className={`text-xs ${cmpPctColor(q?.pct_change != null ? Number(q.pct_change) : null)}`}>
                      {q?.pct_change != null ? pctFmt(Number(q.pct_change)) : ""}
                    </div>
                  </td>
                  <td className="px-3 text-right text-gray-300">
                    {q?.pe != null ? Number(q.pe).toFixed(1) : "—"}
                  </td>
                  <td className="px-3 text-right text-gray-500">
                    {q?.sector_pe != null ? Number(q.sector_pe).toFixed(1) : "—"}
                  </td>
                  <td className="px-3 text-right">
                    {rev != null
                      ? <span className="text-gray-300">{fmt(Number(rev))}</span>
                      : <span className="text-yellow-700 text-xs italic">Awaited</span>}
                  </td>
                  <td className={`px-3 text-right ${rev != null ? pctColor(revGrowth) : "text-gray-600"}`}>
                    {rev != null ? (revGrowth != null ? pctFmt(revGrowth) : "—") : "—"}
                  </td>
                  <td className="px-3 text-right">
                    {np != null
                      ? <span className="text-gray-300">{fmt(Number(np))}</span>
                      : <span className="text-yellow-700 text-xs italic">Awaited</span>}
                  </td>
                  <td className={`px-3 text-right ${np != null ? pctColor(npGrowth) : "text-gray-600"}`}>
                    {np != null ? (npGrowth != null ? pctFmt(npGrowth) : "—") : "—"}
                  </td>
                  <td className="px-3 text-right">
                    <span className={dma200Color}>
                      {q?.dma_200 != null ? fmt(Number(q.dma_200)) : "—"}
                    </span>
                  </td>
                  <td className="px-3 text-right">
                    <span className={dma50Color}>
                      {q?.dma_50 != null ? fmt(Number(q.dma_50)) : "—"}
                    </span>
                    {q?.dma_50 != null &&
                      q?.dma_200 != null &&
                      Math.abs(Number(q.dma_50) - Number(q.dma_200)) / Number(q.dma_200) <= 0.02 && (
                        <span className="ml-1 text-yellow-400" title="DMA-50 within 2% of DMA-200">★</span>
                      )}
                  </td>
                  <td className={`px-3 text-right font-medium ${cmpDmaColor(cmpDma50)}`}>
                    {cmpDma50 != null ? pctFmt(cmpDma50) : "—"}
                  </td>
                  <td className={`px-4 text-right font-medium ${volRatioColor(vRatio)}`}>
                    {vRatio != null ? vRatio.toFixed(2) + "×" : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="mt-3 flex gap-6 text-xs text-gray-600 flex-wrap">
        <span>
          DMA-200/50:{" "}
          <span className="text-emerald-500">green</span>=CMP above ·{" "}
          <span className="text-red-400">red</span>=CMP below ·{" "}
          <span className="text-yellow-400">★</span>=DMA-50 within 2% of DMA-200
        </span>
        <span>
          Rev/NP growth:{" "}
          <span className="text-emerald-400">≥20%</span> ·{" "}
          <span className="text-orange-400">0-10%</span> ·{" "}
          <span className="text-red-400">negative</span>
        </span>
        <span>
          CMP/DMA-50:{" "}
          <span className="text-emerald-400">+ve</span>=above ·{" "}
          <span className="text-red-400">-ve</span>=below
        </span>
        <span>
          Vol ratio:{" "}
          <span className="text-emerald-400">≥1.5×</span> elevated ·{" "}
          <span className="text-red-400">≤0.7×</span> suppressed
        </span>
        <span className="ml-auto text-gray-700 italic">CMP auto-refreshes hourly · Mon–Fri 9:15–16:00 IST</span>
      </div>
    </div>
  );
}
