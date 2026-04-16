import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes without conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format an ISO-8601 date string as a human-readable relative time. */
export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Format a date as a short human-readable string. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Return a colour token representing a PR status.
 * Returned values are Tailwind CSS class fragments.
 */
export function prStatusColor(
  status: string
): "green" | "purple" | "gray" | "red" {
  switch (status) {
    case "open":
      return "green";
    case "merged":
      return "purple";
    case "closed":
      return "gray";
    case "flagged_needs_human":
      return "red";
    default:
      return "gray";
  }
}

/** Truncate a string to maxLen chars, appending '…' if trimmed. */
export function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

/** Convert a grouping strategy enum value to a display label. */
export function groupingStrategyLabel(strategy: string): string {
  switch (strategy) {
    case "per-dep":
      return "Per dependency";
    case "per-family":
      return "Per family (e.g. @aws-sdk/*)";
    case "per-release-window":
      return "Per release window";
    default:
      return strategy;
  }
}
