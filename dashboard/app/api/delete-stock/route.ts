import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const OWNER = "goelvaibhavgoel";
const REPO  = "stock-analyser";

// Remove all lines containing `nse_code: <CODE>` or `<CODE>:` (for TS files)
async function patchGitHubFile(
  token: string,
  path: string,
  removePattern: RegExp,
  commitMsg: string
): Promise<void> {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const getRes = await fetch(url, { headers });
  if (!getRes.ok) {
    console.warn(`[delete-stock] GitHub GET ${path} failed:`, getRes.status);
    return;
  }
  const { content, sha } = await getRes.json() as { content: string; sha: string };
  const decoded = Buffer.from(content, "base64").toString("utf-8");

  const updated = decoded
    .split("\n")
    .filter((line) => !removePattern.test(line))
    .join("\n");

  if (updated === decoded) return; // Nothing to remove

  const putRes = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: commitMsg,
      content: Buffer.from(updated).toString("base64"),
      sha,
    }),
  });

  if (!putRes.ok) {
    const txt = await putRes.text();
    console.error(`[delete-stock] GitHub PUT ${path} failed:`, putRes.status, txt);
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

  // 2. Remove from watchlist.yaml and fy27_guidance.ts via GitHub API
  //    so the hourly pipeline never re-inserts the stock
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    await Promise.all([
      patchGitHubFile(
        token,
        "config/watchlist.yaml",
        // matches any line with nse_code: SYMBOL, or nse_code: SYMBOL}
        new RegExp(`nse_code:\\s*${nse_code}[,\\s}]`),
        `Remove ${nse_code} from watchlist`
      ),
      patchGitHubFile(
        token,
        "dashboard/lib/fy27_guidance.ts",
        // matches the TS object key line:  SYMBOL: { guidance: ...
        new RegExp(`^\\s+${nse_code}:\\s*\\{`),
        `Remove ${nse_code} from FY27 guidance`
      ),
    ]);
  } else {
    console.warn("[delete-stock] GITHUB_TOKEN not set — skipping file patch");
  }

  return NextResponse.json({ ok: true, found: !!(data && data.length > 0) });
}
