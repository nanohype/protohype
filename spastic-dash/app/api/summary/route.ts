import { NextResponse } from "next/server";
import { readEnrichedSessions } from "@/src/reader";
import { computeSummary } from "@/src/aggregator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const sessions = await readEnrichedSessions();
    const dailyBudget = parseFloat(process.env.DAILY_BUDGET_USD ?? "10");
    const summary = computeSummary(sessions, dailyBudget);
    return NextResponse.json(summary);
  } catch (err) {
    console.error("[api/summary]", err);
    return NextResponse.json({ error: "Failed to compute summary" }, { status: 500 });
  }
}
