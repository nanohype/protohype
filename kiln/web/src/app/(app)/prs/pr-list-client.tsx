"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { listTeamPRs } from "@/lib/api";
import { PRCard } from "@/components/pr-card";
import { MetricsStrip } from "@/components/metrics-strip";
import { getTeamMetrics } from "@/lib/api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { KilnPRStatus } from "@/types";

const STATUS_OPTIONS: { label: string; value: KilnPRStatus | "all" }[] = [
  { label: "All", value: "all" },
  { label: "Open", value: "open" },
  { label: "Needs review", value: "flagged_needs_human" },
  { label: "Merged", value: "merged" },
  { label: "Closed", value: "closed" },
];

interface PRListClientProps {
  teamId: string;
}

export function PRListClient({ teamId }: PRListClientProps) {
  const { data: session } = useSession();
  const [statusFilter, setStatusFilter] = useState<KilnPRStatus | "all">(
    "all"
  );

  const token = (session as Record<string, unknown> | null)?.accessToken as
    | string
    | undefined;

  const { data: metrics } = useQuery({
    queryKey: ["metrics", teamId],
    queryFn: () => getTeamMetrics(teamId, token ?? "", 30),
    enabled: !!teamId && !!token,
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["prs", teamId, statusFilter],
    queryFn: () =>
      listTeamPRs(teamId, token ?? "", {
        status: statusFilter === "all" ? undefined : statusFilter,
        limit: 20,
      }),
    enabled: !!teamId && !!token,
  });

  if (!teamId) {
    return (
      <p className="text-sm text-neutral-500">
        No team found. Ask your platform admin to onboard your team.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {/* Metrics */}
      {metrics && <MetricsStrip metrics={metrics} />}

      {/* Filters */}
      <div className="flex items-center gap-3">
        <label
          htmlFor="status-filter"
          className="text-sm font-medium text-neutral-700"
        >
          Status
        </label>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as KilnPRStatus | "all")}
        >
          <SelectTrigger id="status-filter" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* List */}
      {isLoading && (
        <div className="grid gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-lg bg-neutral-100"
            />
          ))}
        </div>
      )}

      {error && (
        <p className="text-sm text-red-600">
          Failed to load pull requests. Please retry.
        </p>
      )}

      {data && data.items.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-200 p-8 text-center">
          <p className="text-sm text-neutral-500">No PRs found.</p>
          {statusFilter !== "all" && (
            <p className="mt-1 text-xs text-neutral-400">
              Try changing the status filter.
            </p>
          )}
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="grid gap-4">
          {data.items.map((pr) => (
            <PRCard key={pr.id} pr={pr} />
          ))}
          {data.nextCursor && (
            <p className="text-center text-xs text-neutral-400">
              Showing {data.items.length} of {data.totalCount} — pagination
              coming soon
            </p>
          )}
        </div>
      )}
    </div>
  );
}
