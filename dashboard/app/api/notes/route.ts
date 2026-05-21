import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function sb() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );
}

// GET /api/notes — returns { [nse_code]: string }
export async function GET() {
  const { data, error } = await sb()
    .from("stock_notes")
    .select("nse_code,note");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const map: Record<string, string> = {};
  for (const row of data ?? []) {
    if (row.note) map[row.nse_code] = row.note;
  }
  return NextResponse.json(map);
}

// POST /api/notes — { nse_code: string, note: string }
export async function POST(req: NextRequest) {
  const { nse_code, note } = (await req.json()) as { nse_code: string; note: string };
  if (!nse_code) {
    return NextResponse.json({ error: "nse_code required" }, { status: 400 });
  }

  if (!note.trim()) {
    // Delete the note row when clearing
    const { error } = await sb()
      .from("stock_notes")
      .delete()
      .eq("nse_code", nse_code);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const { error } = await sb()
    .from("stock_notes")
    .upsert({ nse_code, note, updated_at: new Date().toISOString() });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
