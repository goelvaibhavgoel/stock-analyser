import { NextRequest, NextResponse } from "next/server";

const OWNER = "goelvaibhavgoel";
const REPO  = "stock-analyser";

export async function POST(req: NextRequest) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "GITHUB_TOKEN not configured" }, { status: 500 });
  }

  const { mode } = (await req.json()) as { mode: "quick" | "all" };

  // quick = refresh_cmp.yml (technical only, no Tesseract, ~2-3 min)
  // all   = refresh.yml    (technical + fundamental + macro, ~10-15 min)
  const workflow = mode === "all" ? "refresh.yml" : "refresh_cmp.yml";
  const body: Record<string, unknown> = { ref: "main" };
  if (mode === "all") body.inputs = { phases: "technical,fundamental,macro" };

  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: text }, { status: res.status });
  }

  return NextResponse.json({ ok: true });
}
