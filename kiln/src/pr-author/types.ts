import type { BreakingChange } from "../changelog/types.js";
import type { PatchResult } from "../patcher/types.js";

export interface MigrationNotesInput {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  changelogUrl: string;
  breakingChanges: BreakingChange[];
  patchResults: PatchResult[];
  /** Deps grouped alongside this one (for per-family / per-window groups) */
  groupedDeps?: Array<{ packageName: string; fromVersion: string; toVersion: string }>;
  teamId: string;
}

export interface PrDescription {
  title: string;
  body: string;
  branchName: string;
  labels: string[];
}
