import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const STATUS_STYLE: Record<string, string> = {
  success: "text-emerald-600",
  running: "text-yellow-600",
  failed: "text-red-500",
};

async function getRuns() {
  const { data } = await supabase
    .from("runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(20);
  return data ?? [];
}

function fmt(dt: string | null) {
  if (!dt) return "—";
  return new Date(dt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
}

function duration(start: string, end: string | null) {
  if (!end) return "—";
  const secs = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export default async function RunsPage() {
  const runs = await getRuns();

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4">Run Log</h1>
      {runs.length === 0 ? (
        <p className="text-gray-500">No runs yet.</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-gray-200 text-gray-500 text-left">
              <th className="py-2 pr-4">#</th>
              <th className="pr-4">Started (IST)</th>
              <th className="pr-4">Duration</th>
              <th className="pr-4">Status</th>
              <th className="pr-4 text-right">Tokens</th>
              <th className="pr-4 text-right">Cache Hit %</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r: any) => (
              <tr key={r.id} className="border-b border-gray-200">
                <td className="py-2 pr-4 text-gray-400">{r.id}</td>
                <td className="pr-4 text-gray-700">{fmt(r.started_at)}</td>
                <td className="pr-4 text-gray-600">{duration(r.started_at, r.finished_at)}</td>
                <td className={`pr-4 font-semibold ${STATUS_STYLE[r.status] ?? "text-gray-500"}`}>{r.status}</td>
                <td className="pr-4 text-right text-gray-700">{r.tokens_used?.toLocaleString() ?? "—"}</td>
                <td className="pr-4 text-right text-gray-700">
                  {r.cache_hit_rate != null ? `${(Number(r.cache_hit_rate) * 100).toFixed(0)}%` : "—"}
                </td>
                <td className="text-gray-500 text-xs">{r.notes ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export const revalidate = 60;
