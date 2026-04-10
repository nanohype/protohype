import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/budget — returns current budget config */
export async function GET() {
  return NextResponse.json({
    dailyBudget: parseFloat(process.env.DAILY_BUDGET_USD ?? "10"),
    perSessionBudget: parseFloat(process.env.PER_SESSION_BUDGET_USD ?? "1"),
  });
}

/** POST /api/budget — runtime budget update (env-level; restart required for persistence) */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { dailyBudget?: number; perSessionBudget?: number };
    // In a stateless deployment, we just return the validated values.
    // For persistence, set DAILY_BUDGET_USD in fly secrets.
    const dailyBudget = typeof body.dailyBudget === "number" && body.dailyBudget > 0
      ? body.dailyBudget
      : parseFloat(process.env.DAILY_BUDGET_USD ?? "10");
    return NextResponse.json({ dailyBudget, note: "To persist, run: fly secrets set DAILY_BUDGET_USD=" + dailyBudget });
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
}
