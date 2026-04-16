export interface ChangelogEntry {
  version: string;
  date?: string;
  sections: ChangelogSection[];
  rawMarkdown: string;
}

export interface ChangelogSection {
  title: string;
  items: string[];
  isBreaking: boolean;
}

export interface BreakingChange {
  description: string;
  apiSurface?: string;
  migrationHint?: string;
  conventionalCommit?: string;
}

export interface ParsedChangelog {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  entries: ChangelogEntry[];
  breakingChanges: BreakingChange[];
  changelogUrl: string;
}

export interface ChangelogFetchOptions {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  /** Explicit changelog URL, or auto-discovered from npm registry */
  changelogUrl?: string;
  /** Timeout in ms (default 10_000) */
  timeoutMs?: number;
}
