import { NextRequest, NextResponse } from "next/server";
import { readEnrichedSessions } from "@/src/reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
    const perPage = Math.min(100, Math.max(10, parseInt(searchParams.get("perPage") ?? "50", 10)));
    const search = (searchParams.get("q") ?? "").toLowerCase().trim();
    const sortBy = searchParams.get("sort") ?? "startedAt";
    const sortDir = searchParams.get("dir") === "asc" ? "asc" : "desc";

    let sessions = await readEnrichedSessions();

    // Filter
    if (search) {
      sessions = sessions.filter(
        (s) =>
          s.workflow.toLowerCase().includes(search) ||
          s.agentRole.toLowerCase().includes(search) ||
          s.model.toLowerCase().includes(search)
      );
    }

    // Sort
    sessions.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (sortBy) {
        case "cost":       av = a.cost;          bv = b.cost; break;
        case "inputTokens": av = a.inputTokens;  bv = b.inputTokens; break;
        case "outputTokens": av = a.outputTokens; bv = b.outputTokens; break;
        case "durationMs": av = a.durationMs ?? 0; bv = b.durationMs ?? 0; break;
        case "workflow":   av = a.workflow;       bv = b.workflow; break;
        case "agentRole":  av = a.agentRole;      bv = b.agentRole; break;
        default:           av = a.startedAt;      bv = b.startedAt;
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });

    const total = sessions.length;
    const start = (page - 1) * perPage;
    const items = sessions.slice(start, start + perPage);

    return NextResponse.json({ items, total, page, perPage });
  } catch (err) {
    console.error("[api/sessions]", err);
    return NextResponse.json({ error: "Failed to load sessions" }, { status: 500 });
  }
}
