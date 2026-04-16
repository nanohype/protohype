/**
 * PR grouping strategy — mirrors Renovate's groupName config so teams with
 * existing grouping preferences migrate in place without relearning the knob.
 */
export type GroupingStrategy =
  | { type: "per-dep" }
  | { type: "per-family"; pattern: string } // glob-style prefix, e.g. "@aws-sdk/*"
  | { type: "per-release-window"; windowDays: number }; // all updates within N-day window

export interface DepUpdate {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  /** ISO-8601 timestamp of the upstream publish */
  publishedAt: string;
}

export interface PrGroup {
  /** Stable ID for idempotent PR creation */
  groupId: string;
  /** Human-readable title fragment, used in PR title and branch name */
  label: string;
  updates: DepUpdate[];
}
