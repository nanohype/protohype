import { NextRequest, NextResponse } from "next/server";
import { readEnrichedSessions } from "@/src/reader";
import { computeAgentCosts, computeWorkflowCosts, computeDayBuckets } from "@/src/aggregator";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const filter = (searchParams.get("filter") ?? "today") as "session" | "today" | "week" | "all";
    const days = Math.min(30, Math.max(7, parseInt(searchParams.get("days") ?? "7", 10)));

    const sessions = await readEnrichedSessions();

    return NextResponse.json({
      agentCosts: computeAgentCosts(sessions, filter),
      workflowCosts: computeWorkflowCosts(sessions, filter),
      dayBuckets: computeDayBuckets(sessions, days),
    });
  } catch (err) {
    console.error("[api/trends]", err);
    return NextResponse.json({ error: "Failed to compute trends" }, { status: 500 });
  }
}
