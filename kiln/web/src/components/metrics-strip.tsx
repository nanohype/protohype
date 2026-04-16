import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { TeamMetrics } from "@/types";

interface MetricsStripProps {
  metrics: TeamMetrics;
}

function MetricCell({
  label,
  value,
  target,
  unit,
  met,
}: {
  label: string;
  value: string;
  target: string;
  unit?: string;
  met: boolean | null;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-neutral-500">{label}</p>
      <p
        className={
          "text-2xl font-bold tabular-nums " +
          (met === null
            ? "text-neutral-400"
            : met
              ? "text-green-600"
              : "text-red-500")
        }
      >
        {value}
        {unit && (
          <span className="ml-1 text-sm font-normal text-neutral-500">
            {unit}
          </span>
        )}
      </p>
      <p className="text-xs text-neutral-400">target {target}</p>
    </div>
  );
}

/**
 * Header strip showing the key success-criteria metrics for a team.
 * Numbers are coloured green when on-target, red when below target,
 * grey when there's not enough data (null).
 */
export function MetricsStrip({ metrics }: MetricsStripProps) {
  const medianMet =
    metrics.medianMergeDays === null
      ? null
      : metrics.medianMergeDays <= 7;

  const triggerMet =
    metrics.releaseTriggeredPct === null
      ? null
      : metrics.releaseTriggeredPct >= 90;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-neutral-500">
          Last {metrics.windowDays} days
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <MetricCell
            label="Median merge time"
            value={
              metrics.medianMergeDays !== null
                ? String(metrics.medianMergeDays)
                : "—"
            }
            unit="days"
            target="≤7 days"
            met={medianMet}
          />
          <MetricCell
            label="Release coverage"
            value={
              metrics.releaseTriggeredPct !== null
                ? `${metrics.releaseTriggeredPct}%`
                : "—"
            }
            target="≥90%"
            met={triggerMet}
          />
          <MetricCell
            label="Open PRs"
            value={String(metrics.openPrCount)}
            target="—"
            met={null}
          />
          <MetricCell
            label="Flagged PRs"
            value={String(metrics.flaggedPrCount)}
            target="0"
            met={metrics.flaggedPrCount === 0}
          />
        </div>
      </CardContent>
    </Card>
  );
}
