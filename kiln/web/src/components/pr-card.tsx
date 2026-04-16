import { ExternalLink, GitPullRequest, ShieldCheck } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PRStatusBadge } from "@/components/pr-status-badge";
import { BreakingChangeItem } from "@/components/breaking-change-item";
import { relativeTime, groupingStrategyLabel } from "@/lib/utils";
import type { KilnPR } from "@/types";

interface PRCardProps {
  pr: KilnPR;
  /** When true, shows full migration notes. When false, shows a summary. */
  expanded?: boolean;
}

/**
 * Renders a Kiln-authored PR with its migration notes.
 *
 * Every Kiln PR must cite ≥1 vendor changelog URL and name every breaking
 * change by file:line. This component surfaces both.
 */
export function PRCard({ pr, expanded = false }: PRCardProps) {
  const { migrationNotes } = pr;
  const hasBreakingChanges = migrationNotes.breakingChanges.length > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <PRStatusBadge status={pr.status} />
              {pr.isSigned && (
                <Badge variant="outline" className="gap-1">
                  <ShieldCheck className="h-3 w-3 text-green-600" />
                  Verified
                </Badge>
              )}
              {hasBreakingChanges && (
                <Badge variant="warning">
                  {migrationNotes.breakingChanges.length} breaking{" "}
                  {migrationNotes.breakingChanges.length === 1
                    ? "change"
                    : "changes"}
                </Badge>
              )}
            </div>
            <CardTitle className="mt-2 text-sm leading-snug">
              <a
                href={pr.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline inline-flex items-center gap-1"
                aria-label={`Open PR #${pr.prNumber} on GitHub`}
              >
                <GitPullRequest className="h-4 w-4 shrink-0 text-neutral-400" />
                {pr.title}
                <ExternalLink className="h-3 w-3 shrink-0 text-neutral-400" />
              </a>
            </CardTitle>
            <p className="mt-1 text-xs text-neutral-500">
              {pr.repoFullName} · #{pr.prNumber} ·{" "}
              {relativeTime(pr.openedAt)} ·{" "}
              {groupingStrategyLabel(pr.groupKey)}
            </p>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Package upgrades */}
        <div className="flex flex-wrap gap-1.5">
          {migrationNotes.packages.map((pkg) => (
            <Badge key={pkg.name} variant="secondary">
              {pkg.name} {pkg.fromVersion} → {pkg.toVersion}
            </Badge>
          ))}
        </div>

        {/* Migration notes summary */}
        {migrationNotes.summary && (
          <p className="text-sm text-neutral-700">{migrationNotes.summary}</p>
        )}

        {/* Changelog URLs */}
        <div className="flex flex-wrap gap-2">
          {migrationNotes.changelogUrls.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
            >
              Changelog
              <ExternalLink className="h-3 w-3" />
            </a>
          ))}
        </div>

        {/* Breaking changes — shown only when expanded or when there are few */}
        {hasBreakingChanges &&
          (expanded || migrationNotes.breakingChanges.length <= 3) && (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Breaking changes
              </p>
              {migrationNotes.breakingChanges.map((change, i) => (
                <BreakingChangeItem
                  key={`${change.filePath}-${i}`}
                  change={change}
                />
              ))}
            </div>
          )}

        {/* Collapsed view hint */}
        {!expanded && migrationNotes.breakingChanges.length > 3 && (
          <p className="text-xs text-neutral-500">
            +{migrationNotes.breakingChanges.length - 3} more breaking changes
            — view PR for full migration notes
          </p>
        )}
      </CardContent>
    </Card>
  );
}
