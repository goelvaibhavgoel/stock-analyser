import { createClient } from "@supabase/supabase-js";
import { WatchlistClient } from "@/components/WatchlistClient";
import type { RowData } from "@/components/WatchlistClient";
import { FY27_GUIDANCE } from "@/lib/fy27_guidance";

export const dynamic = "force-dynamic";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

async function getData(): Promise<{ rows: RowData[]; stocksWithEvents: Set<number> }> {
  const { data: stocks } = await supabase
    .from("stocks")
    .select("id,nse_code,name,sector,market_cap_bucket")
    .order("sector");

  if (!stocks?.length) return { rows: [], stocksWithEvents: new Set() };

  const stockIds = stocks.map((s) => s.id);
  const today = new Date().toISOString().split("T")[0];

  const [quotesRes, fundRes, q4Res, eventsRes] = await Promise.all([
    supabase
      .from("daily_quotes")
      .select("stock_id,date,cmp,pct_change,pe,sector_pe,dma_50,dma_200,volume_7d,avg_volume_30d")
      .in("stock_id", stockIds)
      .order("date", { ascending: false })
      .limit(stockIds.length * 10),
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

  // latest row per stock (for DMA), plus fallback CMP from most recent non-null row
  const quoteMap: Record<number, any> = {};
  const latestCmpMap: Record<number, any> = {};
  for (const q of quotesRes.data ?? []) {
    if (!quoteMap[q.stock_id]) quoteMap[q.stock_id] = q;
    if (!latestCmpMap[q.stock_id] && q.cmp != null) latestCmpMap[q.stock_id] = q;
  }
  for (const [idStr, row] of Object.entries(quoteMap)) {
    const id = Number(idStr);
    if (row.cmp == null && latestCmpMap[id]) {
      row.cmp = latestCmpMap[id].cmp;
      row.pct_change = latestCmpMap[id].pct_change;
      row.pe = latestCmpMap[id].pe;
    }
  }

  const fundMap: Record<number, Record<string, any>> = {};
  for (const f of fundRes.data ?? []) {
    if (!fundMap[f.stock_id]) fundMap[f.stock_id] = {};
    fundMap[f.stock_id][f.period] = f;
  }

  const q4ConfirmedSet = new Set<number>();
  for (const r of q4Res.data ?? []) {
    if (!r.is_pending && r.revenue != null) q4ConfirmedSet.add(r.stock_id);
  }

  const stocksWithEvents = new Set<number>(
    (eventsRes.data ?? []).map((e: any) => e.stock_id)
  );

  return {
    rows: stocks.map((s) => {
      const g = FY27_GUIDANCE[s.nse_code] ?? null;
      return {
        ...s,
        quote:          quoteMap[s.id] ?? null,
        funds:          fundMap[s.id] ?? {},
        fy26Complete:   q4ConfirmedSet.has(s.id),
        fy27Guidance:   g?.guidance  ?? null,
        fy27Remarks:    g?.remarks   ?? null,
      };
    }),
    stocksWithEvents,
  };
}

export default async function WatchlistPage() {
  const { rows, stocksWithEvents } = await getData();

  if (rows.length === 0) {
    return (
      <div className="text-gray-500 text-center mt-20">
        No data yet. Run{" "}
        <code className="text-blue-400">python run.py --phase technical</code> first.
      </div>
    );
  }

  const latestDate = rows.find((r) => r.quote?.date)?.quote?.date ?? "";

  return (
    <WatchlistClient
      initialRows={rows}
      stocksWithEventsArr={Array.from(stocksWithEvents)}
      latestDate={latestDate}
    />
  );
}
