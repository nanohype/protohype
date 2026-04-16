import { NextResponse } from "next/server";

/** Health check — used by ALB/ECS health checks and /readyz equivalent. */
export function GET() {
  return NextResponse.json(
    { status: "ok", service: "kiln-web", ts: new Date().toISOString() },
    { status: 200 }
  );
}
