import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const OWNER = "goelvaibhavgoel";
const REPO  = "stock-analyser";
const WATCHLIST_PATH = "config/watchlist.yaml";

async function githubGet(token: string, path: string) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status}`);
  return res.json();
}

async function appendToWatchlist(token: string, stock: {
  nse_code: string; name: string; sector: string; market_cap_bucket: string; screener_url: string;
}) {
  const file = await githubGet(token, WATCHLIST_PATH);
  const existing = Buffer.from(file.content, "base64").toString("utf-8");

  // Extract screener code from URL: .../company/CODE/... or .../company/CODE
  const screenerMatch = stock.screener_url.match(/\/company\/([^/]+)/);
  const screenerCode = screenerMatch ? screenerMatch[1].toUpperCase() : stock.nse_code;
  const screenerOverride = screenerCode !== stock.nse_code
    ? `  # screener_code: ${screenerCode}\n` : "";

  const bucket = stock.market_cap_bucket.toUpperCase();
  const newLine = `  - { nse_code: ${stock.nse_code.padEnd(12)}, name: ${stock.name}, sector: ${stock.sector}, market_cap_bucket: ${bucket} }\n`;

  // Append before the last non-empty line or at the end
  const updated = existing.trimEnd() + "\n" + screenerOverride + newLine;

  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${WATCHLIST_PATH}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `Add ${stock.nse_code} to watchlist`,
      content: Buffer.from(updated).toString("base64"),
      sha: file.sha,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub PUT failed: ${res.status} ${txt}`);
  }
}

async function dispatchRefresh(token: string, nse_code: string) {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/refresh_single.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { nse_code, phases: "technical,fundamental" } }),
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    console.error("[add-stock] workflow dispatch failed:", res.status, txt);
  }
}

export async function POST(req: NextRequest) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return NextResponse.json({ error: "GITHUB_TOKEN not configured" }, { status: 500 });

  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

  const body = (await req.json()) as {
    nse_code: string; name: string; screener_url?: string;
  };

  const { nse_code, name, screener_url = "" } = body;
  if (!nse_code || !name) {
    return NextResponse.json({ error: "nse_code and name required" }, { status: 400 });
  }

  const code = nse_code.toUpperCase();

  // 1. Upsert into Supabase stocks table (sector/market_cap_bucket left blank; pipeline fills them)
  const { error: dbErr } = await supabase
    .from("stocks")
    .upsert({ nse_code: code, name, sector: "IT", market_cap_bucket: "MID" }, { onConflict: "nse_code" });
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

  // 2. Append to watchlist.yaml via GitHub API
  try {
    await appendToWatchlist(token, { nse_code: code, name, sector: "IT", market_cap_bucket: "MID", screener_url });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `watchlist update failed: ${msg}` }, { status: 500 });
  }

  // 3. Dispatch refresh_single workflow to populate data
  await dispatchRefresh(token, code);

  return NextResponse.json({ ok: true });
}
