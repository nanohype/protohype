import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import { truncate } from "@/lib/utils";
import type { BreakingChange } from "@/types";

interface BreakingChangeItemProps {
  change: BreakingChange;
}

/**
 * Renders a single breaking change from a Kiln PR's migration notes.
 * Shows file:line, resolution status, changelog URL, and patch note.
 */
export function BreakingChangeItem({ change }: BreakingChangeItemProps) {
  const isPatchd = change.resolution === "patched";

  return (
    <div className="flex gap-3 rounded-md border border-neutral-100 bg-neutral-50 p-3">
      <div className="mt-0.5 shrink-0">
        {isPatchd ? (
          <CheckCircle2
            className="h-4 w-4 text-green-600"
            aria-label="Patched by Kiln"
          />
        ) : (
          <AlertTriangle
            className="h-4 w-4 text-amber-500"
            aria-label="Needs human review"
          />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium text-neutral-900">
          {change.description}
        </p>
        <p className="font-mono text-xs text-neutral-500">
          {change.filePath}:{change.lineRange.start}–{change.lineRange.end}
        </p>
        {change.patchNote && (
          <p className="text-xs text-neutral-600">
            {truncate(change.patchNote, 160)}
          </p>
        )}
        <a
          href={change.changelogUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
          aria-label="View vendor changelog"
        >
          Changelog
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}
