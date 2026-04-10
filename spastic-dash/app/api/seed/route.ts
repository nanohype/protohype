import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

// Only available in non-production or when ALLOW_SEED=true
export async function POST() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SEED !== "true") {
    return NextResponse.json({ error: "Seeding disabled in production" }, { status: 403 });
  }

  // Inline minimal seed (avoids tsx dependency at runtime)
  const ROLES = ["product", "design", "eng-frontend", "eng-backend", "eng-ai", "qa-automation", "qa-security", "ops-sre", "data-analyst"];
  const WORKFLOWS = ["feature-build", "launch-prep", "sprint-plan", "security-audit", "incident"];
  const MODELS = [
    { name: "claude-sonnet-4-5", w: 0.7 },
    { name: "claude-opus-4-5", w: 0.2 },
    { name: "claude-haiku-3-5", w: 0.1 },
  ];

  const pick = <T extends { w: number }>(arr: T[]): T => {
    const total = arr.reduce((s, i) => s + i.w, 0);
    let r = Math.random() * total;
    for (const item of arr) { r -= item.w; if (r <= 0) return item; }
    return arr[arr.length - 1];
  };

  const sessions = [];
  const now = Date.now();

  for (let d = 6; d >= 0; d--) {
    const dayStart = now - d * 86_400_000;
    const count = 3 + Math.floor(Math.random() * 6);
    for (let i = 0; i < count; i++) {
      const startedAt = new Date(dayStart + Math.floor(Math.random() * 72_000_000));
      const dur = 30_000 + Math.floor(Math.random() * 150_000);
      sessions.push({
        sessionId: `sess_${Math.random().toString(36).slice(2, 12)}`,
        startedAt: startedAt.toISOString(),
        completedAt: new Date(startedAt.getTime() + dur).toISOString(),
        workflow: WORKFLOWS[Math.floor(Math.random() * WORKFLOWS.length)],
        agentRole: ROLES[Math.floor(Math.random() * ROLES.length)],
        model: pick(MODELS).name,
        inputTokens: 2000 + Math.floor(Math.random() * 20000),
        outputTokens: 500 + Math.floor(Math.random() * 6000),
        cacheReadTokens: Math.random() > 0.5 ? Math.floor(Math.random() * 8000) : 0,
        cacheWriteTokens: Math.random() > 0.5 ? Math.floor(Math.random() * 2000) : 0,
        status: "completed",
      });
    }
  }

  sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const filePath = process.env.SPASTIC_PERF_FILE ?? path.join(process.cwd(), ".spastic-perf.json");
  await fs.writeFile(filePath, JSON.stringify({ sessions }, null, 2), "utf8");

  return NextResponse.json({ seeded: sessions.length, path: filePath });
}
