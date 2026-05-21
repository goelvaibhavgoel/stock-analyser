import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const IMPACT_STYLE: Record<string, string> = {
  GREEN: "bg-emerald-100 text-emerald-700",
  RED: "bg-red-100 text-red-600",
  NEUTRAL: "bg-gray-100 text-gray-500",
};

const SECTORS = ["Banking", "IT", "FMCG", "Energy", "Infra", "Metals", "Realty"];

async function getMacroEvents() {
  const { data } = await supabase
    .from("macro_events")
    .select("id, event_date, title, source_url")
    .not("json_analysis", "is", null)
    .order("event_date", { ascending: false })
    .limit(10);
  return data ?? [];
}

async function getImpacts(eventIds: number[]) {
  if (!eventIds.length) return [];
  const { data } = await supabase
    .from("macro_event_impacts")
    .select("event_id, sector, impact, rationale")
    .in("event_id", eventIds);
  return data ?? [];
}

export default async function MacroPage() {
  const events = await getMacroEvents();
  const impacts = await getImpacts(events.map((e) => e.id));

  const impactMap: Record<number, Record<string, { impact: string; rationale: string }>> = {};
  for (const imp of impacts) {
    if (!impactMap[imp.event_id]) impactMap[imp.event_id] = {};
    impactMap[imp.event_id][imp.sector] = { impact: imp.impact, rationale: imp.rationale };
  }

  if (events.length === 0) {
    return (
      <div className="text-gray-500 text-center mt-20">
        No macro events yet. Run <code className="text-blue-400">python run.py --phase macro</code> first.
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4">Macro Events</h1>
      <div className="space-y-8">
        {events.map((ev) => (
          <div key={ev.id} className="border border-gray-200 rounded p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-gray-800">{ev.title}</div>
                {ev.source_url && (
                  <a href={ev.source_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline mt-0.5 block">
                    Source
                  </a>
                )}
              </div>
              <div className="text-xs text-gray-500 whitespace-nowrap">{ev.event_date}</div>
            </div>

            <div className="mt-3 grid grid-cols-7 gap-2">
              {SECTORS.map((sector) => {
                const item = impactMap[ev.id]?.[sector];
                const impact = item?.impact ?? "NEUTRAL";
                return (
                  <div key={sector} className={`rounded p-2 text-center text-xs ${IMPACT_STYLE[impact] ?? IMPACT_STYLE.NEUTRAL}`} title={item?.rationale ?? ""}>
                    <div className="font-semibold">{sector}</div>
                    <div className="mt-0.5 font-bold">{impact === "NEUTRAL" ? "—" : impact}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export const revalidate = 3600;
