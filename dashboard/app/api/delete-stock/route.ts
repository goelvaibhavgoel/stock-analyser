import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const OWNER = "goelvaibhavgoel";
const REPO  = "stock-analyser";

// Trigger the delete_stock workflow which patches watchlist.yaml + fy27_guidance.ts
async function triggerDeleteWorkflow(token: string, nse_code: string): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/delete_stock.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { nse_code } }),
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    console.error("[delete-stock] workflow dispatch failed:", res.status, txt);
  } else {
    console.log("[delete-stock] workflow dispatched for", nse_code);
  }
}

export async function POST(req: NextRequest) {
  const { nse_code } = (await req.json()) as { nse_code: string };
  if (!nse_code) {
    return NextResponse.json({ error: "nse_code required" }, { status: 400 });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );

  // 1. Delete from Supabase (cascades to all child tables)
  const { data, error } = await supabase
    .from("stocks")
    .delete()
    .eq("nse_code", nse_code)
    .select("nse_code");

  if (error) {
    console.error("[delete-stock] Supabase error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 2. Trigger GH Actions workflow to remove from watchlist.yaml + fy27_guidance.ts
  //    The workflow token has contents:write — the Vercel PAT only has workflow scope
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    await triggerDeleteWorkflow(token, nse_code);
  } else {
    console.warn("[delete-stock] GITHUB_TOKEN not set — skipping YAML patch");
  }

  return NextResponse.json({ ok: true, found: !!(data && data.length > 0) });
}
