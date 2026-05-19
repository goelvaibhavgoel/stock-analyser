import { createClient } from "@supabase/supabase-js";
import Link from "next/link";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

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
  return v.toLocaleString("en-IN", { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

function pctFmt(v: number | null): string {
  if (v == null) return "—";
  return (v > 0 ? "+" : "") + v.toFixed(1) + "%";
}

function compute7dAvg(volume7d: any): number | null {
  if (!Array.isArray(volume7d) || volume7d.length === 0) return null;
  const vols = volume7d.map((e: any) => Number(e.volume)).filter(v => v > 0);
  return vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
}

function volRatio(volume7d: any, avg30d: number | null): number | null {
  const avg7 = compute7dAvg(volume7d);
  if (!avg7 || !avg30d) return null;
  return avg7 / avg30d;
}

function yoy(latest: number | null, prev: number | null): number | null {
  if (latest == null || prev == null || prev === 0) return null;
  return ((latest - prev) / Math.abs(prev)) * 100;
}

async function getData() {
  const { data: stocks } = await supabase
    .from("stocks")
    .select("id,nse_code,name,sector,market_cap_bucket")
    .order("sector");

  if (!stocks?.length) return { rows: [], stocksWithEvents: new Set<number>() };

  const stockIds = stocks.map((s) => s.id);
  const today = new Date().toISOString().split("T")[0];

  const [quotesRes, fundRes, q4Res, eventsRes] = await Promise.all([
    supabase
      .from("daily_quotes")
      .select("stock_id,date,cmp,pct_change,pe,sector_pe,dma_50,dma_200,volume_7d,avg_volume_30d")
      .in("stock_id", stockIds)
      .order("date", { ascending: false })
      .limit(stockIds.length * 3),
    supabase
      .from("fundamentals")
      .select("stock_id,period,revenue,net_profit")
      .in("stock_id", stockIds)
      .in("period", ["FY25", "FY26"]),
    supabase
      .from("quarterly_results")
      .select("stock_id,is_pending,revenue")
      .in("stock_id", stockIds)
      .eq("fiscal_year", "FY26")
      .eq("quarter", "Q4"),
    supabase
      .from("stock_events")
      .select("stock_id")
      .in("stock_id", stockIds)
      .eq("event_date", today),
  ]);

  const quoteMap: Record<number, any> = {};
  for (const q of quotesRes.data ?? []) {
    if (!quoteMap[q.stock_id]) quoteMap[q.stock_id] = q;
  }

  const fundMap: Record<number, Record<string, any>> = {};
  for (const f of fundRes.data ?? []) {
    if (!fundMap[f.stock_id]) fundMap[f.stock_id] = {};
    fundMap[f.stock_id][f.period] = f;
  }

  // Q4 FY26 confirmed = exists, not pending, has revenue
  const q4ConfirmedSet = new Set<number>();
  for (const r of q4Res.data ?? []) {
    if (!r.is_pending && r.revenue != null) q4ConfirmedSet.add(r.stock_id);
  }

  const stocksWithEvents = new Set<number>(
    (eventsRes.data ?? []).map((e: any) => e.stock_id)
  );

  return {
    rows: stocks.map((s) => ({
      ...s,
      quote: quoteMap[s.id] ?? null,
      funds: fundMap[s.id] ?? {},
      fy26Complete: q4ConfirmedSet.has(s.id),
    })),
    stocksWithEvents,
  };
}

export default async function WatchlistPage() {
  const { rows, stocksWithEvents } = await getData();

  if (rows.length === 0) {
    return (
      <div className="text-gray-500 text-center mt-20">
        No data yet. Run <code className="text-blue-400">python run.py --phase technical</code> first.
      </div>
    );
  }

  const latestDate = rows.find((r) => r.quote?.date)?.quote?.date ?? "";

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-semibold">Watchlist</h1>
        <span className="text-xs text-gray-500">{rows.length} stocks · as of {latestDate}</span>
      </div>

      <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-10rem)] rounded-lg border border-gray-800">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-gray-900 border-b border-gray-700 text-gray-400 text-xs uppercase tracking-wide">
              <th className="py-3 px-4 text-left bg-gray-900">Stock</th>
              <th className="px-3 text-left bg-gray-900">Sector</th>
              <th className="px-3 text-right bg-gray-900">CMP</th>
              <th className="px-3 text-right bg-gray-900">PE</th>
              <th className="px-3 text-right bg-gray-900">Ind PE</th>
              <th className="px-3 text-right bg-gray-900">Revenue<br/><span className="text-gray-600 normal-case">FY26 Cr</span></th>
              <th className="px-3 text-right bg-gray-900">Rev Growth<br/><span className="text-gray-600 normal-case">YoY %</span></th>
              <th className="px-3 text-right bg-gray-900">Net Profit<br/><span className="text-gray-600 normal-case">FY26 Cr</span></th>
              <th className="px-3 text-right bg-gray-900">NP Growth<br/><span className="text-gray-600 normal-case">YoY %</span></th>
              <th className="px-3 text-right bg-gray-900">200 DMA</th>
              <th className="px-3 text-right bg-gray-900">50 DMA</th>
              <th className="px-3 text-right bg-gray-900">CMP/DMA-50<br/><span className="text-gray-600 normal-case">% diff</span></th>
              <th className="px-4 text-right bg-gray-900">Vol Ratio<br/><span className="text-gray-600 normal-case">7d/30d</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row: any) => {
              const q = row.quote;
              const fy26 = row.fy26Complete ? row.funds["FY26"] : null;
              const fy25 = row.funds["FY25"];

              const rev     = fy26?.revenue     ?? null;
              const np      = fy26?.net_profit  ?? null;
              const revGrowth = yoy(rev, fy25?.revenue ?? null);
              const npGrowth  = yoy(np,  fy25?.net_profit ?? null);
              const vRatio    = q ? volRatio(q.volume_7d, q.avg_volume_30d) : null;
              const cmpVsDma50 = q?.cmp && q?.dma_50
                ? ((Number(q.cmp) - Number(q.dma_50)) / Number(q.dma_50)) * 100
                : null;

              const dmaSignal = q?.dma_50 && q?.dma_200
                ? Number(q.dma_50) > Number(q.dma_200) ? "text-emerald-400" : "text-red-400"
                : "text-gray-400";

              const hasEvent = stocksWithEvents.has(row.id);

              return (
                <tr key={row.id} className="border-b border-gray-800 hover:bg-gray-900/60 transition-colors">
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-1.5">
                      <Link href={`/stock/${row.nse_code}`} className="text-blue-400 hover:text-blue-200 font-semibold text-sm">
                        {row.nse_code}
                      </Link>
                      {hasEvent && (
                        <span
                          className="inline-block w-2 h-2 rounded-full bg-emerald-400 shrink-0"
                          title="New event today"
                        />
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5 max-w-[160px] truncate">{row.name}</div>
                  </td>
                  <td className="px-3">
                    <div className="text-gray-300 text-xs">{row.sector}</div>
                    {row.market_cap_bucket && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded mt-0.5 inline-block ${CAP_STYLE[row.market_cap_bucket] ?? ""}`}>
                        {row.market_cap_bucket}
                      </span>
                    )}
                  </td>
                  <td className="px-3 text-right">
                    <div className="text-white font-medium">{q?.cmp != null ? fmt(Number(q.cmp), 1) : "—"}</div>
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
                    <span className={dmaSignal}>
                      {q?.dma_200 != null ? fmt(Number(q.dma_200)) : "—"}
                    </span>
                  </td>
                  <td className="px-3 text-right">
                    <span className={dmaSignal}>
                      {q?.dma_50 != null ? fmt(Number(q.dma_50)) : "—"}
                    </span>
                  </td>
                  <td className={`px-3 text-right font-medium ${cmpDmaColor(cmpVsDma50)}`}>
                    {cmpVsDma50 != null ? pctFmt(cmpVsDma50) : "—"}
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

      <div className="mt-3 flex gap-6 text-xs text-gray-600">
        <span>DMA-50 <span className="text-emerald-500">green</span>=above DMA-200</span>
        <span>Rev/NP growth: <span className="text-emerald-400">≥20%</span> · <span className="text-orange-400">0-10%</span> · <span className="text-red-400">negative</span></span>
        <span>CMP/DMA-50: <span className="text-emerald-400">+ve</span>=above · <span className="text-red-400">-ve</span>=below</span>
        <span>Vol ratio: <span className="text-emerald-400">≥1.5×</span> elevated · <span className="text-red-400">≤0.7×</span> suppressed</span>
      </div>
    </div>
  );
}

export const revalidate = 3600;
