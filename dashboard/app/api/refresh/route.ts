import { NextRequest, NextResponse } from "next/server";

const OWNER = "goelvaibhavgoel";
const REPO  = "stock-analyser";

export async function POST(req: NextRequest) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "GITHUB_TOKEN not configured" }, { status: 500 });
  }

  const { mode } = (await req.json()) as { mode: "quick" | "all" };

  const workflow = mode === "all" ? "refresh.yml" : "manual_run.yml";
  const inputs   = mode === "all"
    ? { phases: "technical,fundamental,macro" }
    : { phase: "technical" };

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
      body: JSON.stringify({ ref: "main", inputs }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: text }, { status: res.status });
  }

  return NextResponse.json({ ok: true });
}
