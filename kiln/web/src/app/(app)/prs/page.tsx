import { Suspense } from "react";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { PRListClient } from "./pr-list-client";

export const metadata = { title: "Pull Requests — Kiln" };

export default async function PRsPage() {
  const session = await getServerSession(authOptions);
  const teamId = (
    session?.user as Record<string, unknown> | undefined
  )?.teamIds?.[0] as string | undefined;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Pull Requests</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Kiln-authored upgrade PRs for your watched repositories
        </p>
      </div>
      <Suspense
        fallback={
          <div className="grid gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-40 animate-pulse rounded-lg bg-neutral-100"
              />
            ))}
          </div>
        }
      >
        <PRListClient teamId={teamId ?? ""} />
      </Suspense>
    </div>
  );
}
