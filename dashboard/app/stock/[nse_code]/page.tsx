import { createClient } from "@supabase/supabase-js";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FY27_GUIDANCE } from "@/lib/fy27_guidance";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ── helpers ───────────────────────────────────────────────────────────────────

function fmt(v: number | null | undefined, decimals = 0): string {
  if (v == null) return "—";
  return Number(v).toLocaleString("en-IN", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}

function pctFmt(v: number | null | undefined, always = false): string {
  if (v == null) return "—";
  const n = Number(v);
  return (n > 0 ? "+" : "") + n.toFixed(1) + "%";
}

function yoy(latest: number | null, prev: number | null): number | null {
  if (latest == null || prev == null || prev === 0) return null;
  return ((latest - prev) / Math.abs(prev)) * 100;
}

function pctColor(v: number | null) {
  if (v == null) return "";
  if (v >= 20) return "text-emerald-600";
  if (v >= 10) return "text-emerald-500";
  if (v > 0)   return "text-gray-600";
  if (v < -10) return "text-red-500";
  return "text-orange-500";
}

function compute7dAvg(volume7d: any): number | null {
  if (!Array.isArray(volume7d) || !volume7d.length) return null;
  const vols = volume7d.map((e: any) => Number(e.volume)).filter((v) => v > 0);
  return vols.length ? vols.reduce((a: number, b: number) => a + b, 0) / vols.length : null;
}

function volRatio(volume7d: any, avg30d: number | null): number | null {
  const avg7 = compute7dAvg(volume7d);
  if (!avg7 || !avg30d) return null;
  return avg7 / avg30d;
}

const QUARTERS: Array<"Q1" | "Q2" | "Q3" | "Q4"> = ["Q1", "Q2", "Q3", "Q4"];

// ── data fetch ────────────────────────────────────────────────────────────────

async function getData(nse_code: string) {
  const { data: stock } = await supabase
    .from("stocks")
    .select("id,nse_code,name,sector,market_cap_bucket")
    .eq("nse_code", nse_code)
    .single();

  if (!stock) return null;

  const sid = stock.id;

  const [quoteRes, fundRes, qtrRes, flagRes, concallRes, verdictRes, eventsRes] = await Promise.all([
    supabase
      .from("daily_quotes")
      .select("date,cmp,pct_change,market_cap_cr,pe,sector_pe,week_52_high,week_52_low,dma_50,dma_200,volume_today,volume_7d,avg_volume_30d")
      .eq("stock_id", sid)
      .order("date", { ascending: false })
      .limit(1),
    supabase
      .from("fundamentals")
      .select("period,revenue,net_profit,ebitda_margin,pe,pe_12m,promoter_pct")
      .eq("stock_id", sid)
      .in("period", ["FY24", "FY25", "FY26"])
      .order("period"),
    supabase
      .from("quarterly_results")
      .select("fiscal_year,quarter,revenue,net_profit,is_pending")
      .eq("stock_id", sid)
      .in("fiscal_year", ["FY25", "FY26"])
      .order("fiscal_year")
      .order("quarter"),
    supabase
      .from("fundamental_flags")
      .select("flag,rationale")
      .eq("stock_id", sid)
      .order("run_date", { ascending: false })
      .limit(10),
    supabase
      .from("concalls")
      .select("filing_date,json_analysis")
      .eq("stock_id", sid)
      .not("json_analysis", "is", null)
      .order("filing_date", { ascending: false })
      .limit(1),
    supabase
      .from("verdicts")
      .select("score,growth_label,entry_exit,components_json")
      .eq("stock_id", sid)
      .order("run_date", { ascending: false })
      .limit(1),
    supabase
      .from("stock_events")
      .select("event_date,event_summary,source_name,source_link,impact,raw_title")
      .eq("stock_id", sid)
      .not("json_analysis", "is", null)
      .order("event_date", { ascending: false })
      .limit(50),
  ]);

  return {
    stock,
    quote: quoteRes.data?.[0] ?? null,
    funds: Object.fromEntries((fundRes.data ?? []).map((f) => [f.period, f])),
    quarterly: qtrRes.data ?? [],
    flags: flagRes.data ?? [],
    concall: concallRes.data?.[0] ?? null,
    verdict: verdictRes.data?.[0] ?? null,
    stockEvents: eventsRes.data ?? [],
  };
}

// ── sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, valueClass = "" }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded p-2.5">
      <div className="text-[11px] text-gray-500 mb-0.5 leading-tight">{label}</div>
      <div className={`text-sm font-bold ${valueClass}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-500 mt-0.5 leading-tight">{sub}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <h2 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2 pb-0.5 border-b border-gray-200">
        {title}
      </h2>
      {children}
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default async function StockDetailPage({ params }: { params: { nse_code: string } }) {
  const data = await getData(params.nse_code);
  if (!data) return notFound();

  const { stock, quote, funds, quarterly, flags, concall, verdict, stockEvents } = data;
  const fy26 = funds["FY26"];
  const fy25 = funds["FY25"];
  const fy24 = funds["FY24"];

  // Annual fundamentals
  const latestFund = fy26 ?? fy25 ?? null;
  const prevFund   = fy26 ? fy25 : fy24;
  const fy26RevAwaited = fy26 == null || fy26.revenue == null;
  const fy26NpAwaited  = fy26 == null || fy26.net_profit == null;
  const revGrowth  = fy26RevAwaited ? null : yoy(fy26!.revenue, fy25?.revenue);
  const npGrowth   = fy26NpAwaited  ? null : yoy(fy26!.net_profit, fy25?.net_profit);

  // Quarterly pivot
  const qtr: Record<string, Record<string, { revenue: number | null; net_profit: number | null; is_pending: boolean }>> = {
    FY25: { Q1: { revenue: null, net_profit: null, is_pending: false }, Q2: { revenue: null, net_profit: null, is_pending: false }, Q3: { revenue: null, net_profit: null, is_pending: false }, Q4: { revenue: null, net_profit: null, is_pending: false } },
    FY26: { Q1: { revenue: null, net_profit: null, is_pending: false }, Q2: { revenue: null, net_profit: null, is_pending: false }, Q3: { revenue: null, net_profit: null, is_pending: false }, Q4: { revenue: null, net_profit: null, is_pending: false } },
  };
  for (const r of quarterly) {
    if (qtr[r.fiscal_year]?.[r.quarter]) {
      qtr[r.fiscal_year][r.quarter] = { revenue: r.revenue, net_profit: r.net_profit, is_pending: r.is_pending };
    }
  }

  function qTotal(fy: string, field: "revenue" | "net_profit"): number | null {
    const vals = QUARTERS.map((q) => qtr[fy][q][field]).filter((v) => v != null) as number[];
    return vals.length === 4 ? vals.reduce((a, b) => a + b, 0) : null;
  }

  // Volume
  const avg7d    = compute7dAvg(quote?.volume_7d);
  const avg30d   = quote?.avg_volume_30d ? Number(quote.avg_volume_30d) : null;
  const vRatio   = volRatio(quote?.volume_7d, avg30d);
  const dmaAbove = quote?.dma_50 && quote?.dma_200 && Number(quote.dma_50) > Number(quote.dma_200);
  const cmpVsDma50Pct = quote?.cmp && quote?.dma_50
    ? ((Number(quote.cmp) - Number(quote.dma_50)) / Number(quote.dma_50)) * 100
    : null;
  const isBankingOrNBFC = /bank|finance|nbfc|insurance/i.test(stock.sector ?? "");
  const marginLabel = isBankingOrNBFC ? "Financing Margin" : "EBITDA Margin";

  const CAP_STYLE: Record<string, string> = {
    LARGE: "bg-blue-100 text-blue-700",
    MID:   "bg-purple-100 text-purple-700",
    SMALL: "bg-orange-100 text-orange-700",
  };

  return (
    <div className="max-w-5xl">
      {/* Back */}
      <Link href="/" className="text-gray-500 hover:text-gray-700 text-xs">← Watchlist</Link>

      {/* Header */}
      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold">{stock.nse_code}</h1>
          {stock.market_cap_bucket && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${CAP_STYLE[stock.market_cap_bucket] ?? ""}`}>
              {stock.market_cap_bucket}
            </span>
          )}
          {verdict && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
              verdict.growth_label === "H" ? "bg-emerald-100 text-emerald-700 border border-emerald-300" :
              verdict.growth_label === "M" ? "bg-yellow-100 text-yellow-700 border border-yellow-300" :
              "bg-red-100 text-red-600 border border-red-300"
            }`}>{verdict.growth_label}</span>
          )}
          <span className="text-gray-500 text-xs">{stock.name}</span>
          <span className="text-gray-400 text-xs">·</span>
          <span className="text-gray-500 text-xs">{stock.sector}</span>
        </div>
        <div className="ml-auto text-right">
          <div className="text-lg font-bold">{quote?.cmp != null ? fmt(Number(quote.cmp), 2) : "—"}</div>
          <div className={`text-xs ${quote?.pct_change != null ? (Number(quote.pct_change) >= 0 ? "text-emerald-400" : "text-red-400") : "text-gray-500"}`}>
            {quote?.pct_change != null ? pctFmt(Number(quote.pct_change)) : ""} today
          </div>
        </div>
      </div>

      {/* Key Metrics Grid */}
      <Section title="Key Metrics">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          <StatCard label="Current PE" value={quote?.pe != null ? Number(quote.pe).toFixed(1) : "—"} />
          <StatCard label="12-Month PE" value={latestFund?.pe_12m != null ? Number(latestFund.pe_12m).toFixed(1) : "—"} sub="as of 1 year ago" />
          <StatCard label="Industry PE" value={quote?.sector_pe != null ? Number(quote.sector_pe).toFixed(1) : "—"} />
          <StatCard label="Promoter Holding" value={latestFund?.promoter_pct != null ? fmt(Number(latestFund.promoter_pct), 1) + "%" : "—"} />
          <StatCard label="Market Cap" value={quote?.market_cap_cr != null ? "₹" + fmt(Number(quote.market_cap_cr)) + " Cr" : "—"} />
          <StatCard label="52W High" value={quote?.week_52_high != null ? fmt(Number(quote.week_52_high), 1) : "—"} />
          <StatCard label="52W Low" value={quote?.week_52_low != null ? fmt(Number(quote.week_52_low), 1) : "—"} />
          <StatCard label={marginLabel} value={latestFund?.ebitda_margin != null ? fmt(Number(latestFund.ebitda_margin), 1) + "%" : "—"} sub={fy26 ? "FY26" : "FY25"} />
        </div>
      </Section>

      {/* Technical */}
      <Section title="Technical Indicators">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
          <StatCard
            label="DMA-200"
            value={quote?.dma_200 != null ? fmt(Number(quote.dma_200)) : "—"}
            sub={quote?.cmp && quote?.dma_200 ? (Number(quote.cmp) > Number(quote.dma_200) ? "CMP above" : "CMP below") : undefined}
            valueClass={dmaAbove ? "text-emerald-400" : "text-red-400"}
          />
          <StatCard
            label="DMA-50"
            value={quote?.dma_50 != null ? fmt(Number(quote.dma_50)) : "—"}
            valueClass={dmaAbove ? "text-emerald-400" : "text-red-400"}
          />
          <StatCard
            label="DMA-50 vs DMA-200"
            value={dmaAbove ? "Golden" : "Death"}
            valueClass={dmaAbove ? "text-emerald-400" : "text-red-400"}
            sub={dmaAbove ? "50 above 200" : "50 below 200"}
          />
          <StatCard
            label="CMP vs DMA-200"
            value={quote?.cmp && quote?.dma_200
              ? pctFmt(((Number(quote.cmp) - Number(quote.dma_200)) / Number(quote.dma_200)) * 100)
              : "—"}
            valueClass={quote?.cmp && quote?.dma_200 && Number(quote.cmp) > Number(quote.dma_200) ? "text-emerald-400" : "text-red-400"}
          />
          <StatCard
            label="CMP vs DMA-50"
            value={cmpVsDma50Pct != null ? pctFmt(cmpVsDma50Pct) : "—"}
            valueClass={cmpVsDma50Pct == null ? "" : cmpVsDma50Pct > 0 ? "text-emerald-400" : "text-red-400"}
          />
        </div>
      </Section>

      {/* Volume */}
      <Section title="Volume Analysis">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 mb-2">
          <StatCard
            label="~7-Day Avg Volume"
            value={avg7d != null ? (avg7d / 1e5).toFixed(2) + "L shares" : "—"}
            sub="5-day sum ÷ 5"
          />
          <StatCard
            label="~30-Day Avg Volume"
            value={avg30d != null ? (avg30d / 1e5).toFixed(2) + "L shares" : "—"}
            sub="25-day sum ÷ 25"
          />
          <StatCard
            label="Vol Ratio (7d / 30d)"
            value={vRatio != null ? vRatio.toFixed(2) + "×" : "—"}
            valueClass={vRatio == null ? "" : vRatio > 1.5 ? "text-emerald-400" : vRatio > 1.0 ? "text-yellow-400" : "text-red-400"}
            sub={vRatio != null ? (vRatio > 1.3 ? "Above average" : vRatio < 0.7 ? "Below average" : "Near average") : undefined}
          />
        </div>

        {/* volume bars */}
        {Array.isArray(quote?.volume_7d) && quote.volume_7d.length > 0 && (
          <div>
            <div className="text-xs text-gray-500 mb-2">Last {(quote.volume_7d as any[]).length} trading days</div>
            <div className="flex items-end gap-1.5 h-10">
              {(quote.volume_7d as any[]).map((entry: any, i: number) => {
                const vol = Number(entry.volume);
                const maxVol = Math.max(...(quote.volume_7d as any[]).map((e: any) => Number(e.volume)));
                const pct = maxVol > 0 ? (vol / maxVol) * 100 : 0;
                const isHighVsAvg = avg30d && vol > avg30d * 1.3;
                return (
                  <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                    <div className="w-full flex items-end" style={{ height: 32 }}>
                      <div
                        className={`w-full rounded-t ${isHighVsAvg ? "bg-emerald-500" : "bg-gray-300"}`}
                        style={{ height: `${pct}%`, minHeight: 2 }}
                        title={`${entry.date}: ${(vol / 1e5).toFixed(2)}L`}
                      />
                    </div>
                    <div className="text-[9px] text-gray-400 truncate w-full text-center">
                      {entry.date?.slice(5)}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              <span className="inline-block w-2 h-2 bg-emerald-500 rounded-sm mr-1" />above 30d avg · <span className="inline-block w-2 h-2 bg-gray-300 rounded-sm mr-1" />below
            </div>
          </div>
        )}
      </Section>

      {/* Quarterly Revenue */}
      <Section title="Quarterly Revenue (₹ Cr)">
        <div className="overflow-x-auto">
          <table className="text-sm w-full">
            <thead>
              <tr className="text-gray-500 text-xs border-b border-gray-200">
                <th className="py-1 pr-6 text-left">FY</th>
                {QUARTERS.map((q) => <th key={q} className="pr-4 text-right">{q}</th>)}
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {(["FY25", "FY26"] as const).map((fy) => (
                <tr key={fy} className="border-b border-gray-200/70">
                  <td className="py-1 pr-6 font-medium text-gray-700">{fy}</td>
                  {QUARTERS.map((q) => {
                    const cell = qtr[fy][q];
                    return (
                      <td key={q} className="pr-4 text-right text-gray-700">
                        {cell.is_pending
                          ? <span className="text-yellow-600 text-xs">Awaited</span>
                          : cell.revenue != null ? fmt(Number(cell.revenue))
                          : <span className="text-gray-300">—</span>}
                      </td>
                    );
                  })}
                  <td className="text-right text-gray-800 font-medium">
                    {qTotal(fy, "revenue") != null ? fmt(qTotal(fy, "revenue")!) : "—"}
                  </td>
                </tr>
              ))}
              <tr className="border-b border-gray-200/70 text-xs">
                <td className="py-1 pr-6 text-gray-500">YoY Δ</td>
                {QUARTERS.map((q) => {
                  const v25 = qtr["FY25"][q].revenue;
                  const v26 = qtr["FY26"][q].revenue;
                  const g = yoy(v26, v25);
                  return (
                    <td key={q} className={`pr-4 text-right ${pctColor(g)}`}>
                      {g != null ? pctFmt(g) : "—"}
                    </td>
                  );
                })}
                <td className={`text-right ${pctColor(yoy(qTotal("FY26","revenue"), qTotal("FY25","revenue")))}`}>
                  {yoy(qTotal("FY26","revenue"), qTotal("FY25","revenue")) != null
                    ? pctFmt(yoy(qTotal("FY26","revenue"), qTotal("FY25","revenue"))!)
                    : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      {/* Quarterly Net Profit */}
      <Section title="Quarterly Net Profit (₹ Cr)">
        <div className="overflow-x-auto">
          <table className="text-sm w-full">
            <thead>
              <tr className="text-gray-500 text-xs border-b border-gray-200">
                <th className="py-1 pr-6 text-left">FY</th>
                {QUARTERS.map((q) => <th key={q} className="pr-4 text-right">{q}</th>)}
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {(["FY25", "FY26"] as const).map((fy) => (
                <tr key={fy} className="border-b border-gray-200/70">
                  <td className="py-1 pr-6 font-medium text-gray-700">{fy}</td>
                  {QUARTERS.map((q) => {
                    const cell = qtr[fy][q];
                    return (
                      <td key={q} className="pr-4 text-right text-gray-700">
                        {cell.is_pending
                          ? <span className="text-yellow-600 text-xs">Awaited</span>
                          : cell.net_profit != null ? fmt(Number(cell.net_profit))
                          : <span className="text-gray-300">—</span>}
                      </td>
                    );
                  })}
                  <td className="text-right text-gray-800 font-medium">
                    {qTotal(fy, "net_profit") != null ? fmt(qTotal(fy, "net_profit")!) : "—"}
                  </td>
                </tr>
              ))}
              <tr className="border-b border-gray-200/70 text-xs">
                <td className="py-1 pr-6 text-gray-500">YoY Δ</td>
                {QUARTERS.map((q) => {
                  const v25 = qtr["FY25"][q].net_profit;
                  const v26 = qtr["FY26"][q].net_profit;
                  const g = yoy(v26, v25);
                  return (
                    <td key={q} className={`pr-4 text-right ${pctColor(g)}`}>
                      {g != null ? pctFmt(g) : "—"}
                    </td>
                  );
                })}
                <td className={`text-right ${pctColor(yoy(qTotal("FY26","net_profit"), qTotal("FY25","net_profit")))}`}>
                  {yoy(qTotal("FY26","net_profit"), qTotal("FY25","net_profit")) != null
                    ? pctFmt(yoy(qTotal("FY26","net_profit"), qTotal("FY25","net_profit"))!)
                    : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      {/* Screener Link */}
      <Section title="Charts">
        <div className="flex gap-3">
          <a
            href={`https://www.screener.in/company/${stock.nse_code}/consolidated/`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-200 hover:border-blue-400 rounded text-xs text-gray-600 hover:text-blue-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            View Price &amp; PE Chart on Screener.in
          </a>
          <a
            href={`https://www.nseindia.com/get-quotes/equity?symbol=${stock.nse_code}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-gray-200 hover:border-blue-400 rounded text-xs text-gray-600 hover:text-blue-600 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            NSEIndia Quote
          </a>
        </div>
      </Section>

      {/* FY27 Revenue Guidance */}
      {(() => {
        const g = FY27_GUIDANCE[stock.nse_code];
        if (!g) return null;
        const pct = (g.guidance * 100).toFixed(0);
        const color =
          g.guidance >= 0.50 ? "text-emerald-600" :
          g.guidance >= 0.30 ? "text-emerald-600" :
          g.guidance >= 0.20 ? "text-yellow-600"  : "text-gray-600";
        return (
          <Section title="FY27 Revenue Guidance">
            <div className="bg-gray-50 border border-gray-200 rounded p-3 text-xs space-y-1.5">
              <div className="flex items-center gap-3">
                <span className="text-gray-500 shrink-0 w-32">Growth guidance</span>
                <span className={`text-base font-bold ${color}`}>+{pct}%</span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500 shrink-0 w-32">Remarks</span>
                <span className="text-gray-800 leading-relaxed">{g.remarks}</span>
              </div>
            </div>
          </Section>
        );
      })()}

      {/* Concall */}
      {concall?.json_analysis && (
        <Section title={`Latest Concall Analysis · ${concall.filing_date}`}>
          <div className="bg-gray-50 border border-gray-200 rounded p-3 space-y-1.5 text-xs">
            {Object.entries(concall.json_analysis).map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <span className="text-gray-500 capitalize shrink-0 w-32">{k.replace(/_/g, " ")}</span>
                <span className="text-gray-800">{Array.isArray(v) ? (v as string[]).join("; ") : String(v)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Verdict */}
      {verdict && (
        <Section title="Verdict Breakdown">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
            {Object.entries(verdict.components_json ?? {}).map(([k, v]) => (
              <StatCard
                key={k}
                label={k.charAt(0).toUpperCase() + k.slice(1)}
                value={(Number(v) > 0 ? "+" : "") + String(v)}
                valueClass={Number(v) > 0 ? "text-emerald-600" : Number(v) < 0 ? "text-red-500" : "text-gray-500"}
              />
            ))}
            <StatCard label="Total Score" value={Number(verdict.score).toFixed(1)}
              valueClass="text-gray-900" />
          </div>
        </Section>
      )}

      {/* Macro / Events */}
      <Section title="Macro / Events">
        {stockEvents.length === 0 ? (
          <p className="text-xs text-gray-500">No events found yet. Run <code className="text-blue-600">python run.py --phase macro</code> to fetch.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-200">
                  <th className="py-1.5 pr-4 text-left font-normal w-[36%]">Event / Update</th>
                  <th className="pr-4 text-left font-normal w-[10%]">Source</th>
                  <th className="pr-4 text-left font-normal w-[26%]">Link</th>
                  <th className="pr-4 text-left font-normal w-[14%]">Impact</th>
                  <th className="text-left font-normal w-[14%]">Date</th>
                </tr>
              </thead>
              <tbody>
                {(stockEvents as any[]).map((ev, i) => {
                  const summary = ev.event_summary || ev.raw_title || "—";
                  const impact: string = ev.impact ?? "NO_IMPACT";
                  const impactStyle =
                    impact === "GOOD"
                      ? "text-emerald-600"
                      : impact === "BAD"
                      ? "text-red-500"
                      : "text-gray-500";
                  return (
                    <tr key={i} className="border-b border-gray-200/70 align-top">
                      <td className="py-1.5 pr-4 text-gray-700 leading-snug">{summary}</td>
                      <td className="pr-4 text-gray-500">{ev.source_name ?? "—"}</td>
                      <td className="pr-4">
                        {ev.source_link ? (
                          <a
                            href={ev.source_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-800 truncate block max-w-[220px]"
                            title={ev.source_link}
                          >
                            {ev.source_link.length > 40
                              ? ev.source_link.slice(0, 37) + "…"
                              : ev.source_link}
                          </a>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className={`pr-4 font-medium ${impactStyle}`}>
                        {impact === "GOOD" ? "Good" : impact === "BAD" ? "Bad" : "No Impact"}
                      </td>
                      <td className="text-gray-500 whitespace-nowrap">
                        {ev.event_date ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="mt-4 pb-4" />
    </div>
  );
}

export const revalidate = 3600;
