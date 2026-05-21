import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: NextRequest) {
  const { nse_code } = (await req.json()) as { nse_code: string };
  if (!nse_code) {
    return NextResponse.json({ error: "nse_code required" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );

  const { data, error } = await supabase
    .from("stocks")
    .delete()
    .eq("nse_code", nse_code)
    .select("nse_code");   // return deleted row so we can confirm it existed

  if (error) {
    console.error("[delete-stock] Supabase error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data || data.length === 0) {
    // Stock wasn't found — treat as success (already deleted or never existed)
    console.warn("[delete-stock] nse_code not found:", nse_code);
    return NextResponse.json({ ok: true, found: false });
  }

  return NextResponse.json({ ok: true, found: true });
}
