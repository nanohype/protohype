#!/usr/bin/env node
/**
 * Generates realistic sample perf data for demo/development.
 * Usage: npm run seed
 */

import { writePerfData } from "./storage";

const AGENT_ROLES = [
  "product", "design", "engineering", "qa",
  "eng-frontend", "eng-backend", "eng-ai",
  "qa-automation", "qa-security",
  "ops-sre", "ops-incident",
  "data-analyst", "tech-writer",
  "marketing", "sales", "customer-success",
];

const WORKFLOWS = [
  "feature-build", "launch-prep", "sprint-plan",
  "security-audit", "incident", "perf-review",
  "market-push", "content-engine", "customer-onboard",
];

const MODELS = [
  { name: "claude-sonnet-4-5", weight: 0.7 },
  { name: "claude-opus-4-5", weight: 0.2 },
  { name: "claude-haiku-3-5", weight: 0.1 },
];

function pickWeighted<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateSession(startedAt: Date, workflow: string) {
  const model = pickWeighted(MODELS).name;
  const role = AGENT_ROLES[Math.floor(Math.random() * AGENT_ROLES.length)];
  const durationMs = randInt(30_000, 180_000); // 30s – 3min
  const completedAt = new Date(startedAt.getTime() + durationMs);

  const inputTokens = randInt(2_000, 25_000);
  const outputTokens = randInt(500, 8_000);
  const cacheReadTokens = Math.random() > 0.5 ? randInt(1_000, 10_000) : 0;
  const cacheWriteTokens = cacheReadTokens > 0 ? randInt(500, 3_000) : 0;

  return {
    sessionId: `sess_${Math.random().toString(36).slice(2, 12)}`,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    workflow,
    agentRole: role,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    status: "completed" as const,
  };
}

async function seed() {
  const sessions = [];
  const now = new Date();

  // Generate 30 days of data — more sessions on recent days
  for (let dayOffset = 29; dayOffset >= 0; dayOffset--) {
    const day = new Date(now);
    day.setDate(day.getDate() - dayOffset);
    day.setHours(0, 0, 0, 0);

    // 2–12 sessions per day, more on recent days
    const count = dayOffset < 7 ? randInt(5, 12) : randInt(2, 6);

    for (let i = 0; i < count; i++) {
      const sessionStart = new Date(day.getTime() + randInt(0, 86_400_000 - 200_000));
      const workflow = WORKFLOWS[Math.floor(Math.random() * WORKFLOWS.length)];
      sessions.push(generateSession(sessionStart, workflow));
    }
  }

  // Sort chronologically
  sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  await writePerfData(JSON.stringify({ sessions }, null, 2));
  console.log(`Seeded ${sessions.length} sessions`);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
