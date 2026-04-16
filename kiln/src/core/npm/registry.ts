/**
 * npm registry client — version polling and metadata.
 * Explicit 10s timeout on all calls.
 */
import { config } from "../../config.js";
import { log } from "../../telemetry/otel.js";

export interface PackageVersionInfo {
  name: string;
  latestVersion: string;
  publishedAt: string;
  repositoryUrl: string | null;
}

export async function fetchLatestVersion(dep: string): Promise<PackageVersionInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.npm.timeoutMs);

  try {
    const resp = await fetch(
      `${config.npm.registryUrl}/${encodeURIComponent(dep)}/latest`,
      {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "kiln-upgrade-bot/0.1.0",
        },
      },
    );

    if (!resp.ok) {
      throw new Error(`npm registry returned ${resp.status} for ${dep}`);
    }

    const meta = (await resp.json()) as {
      name: string;
      version: string;
      time?: Record<string, string>;
      repository?: { url?: string };
    };

    return {
      name: meta.name,
      latestVersion: meta.version,
      publishedAt: meta.time?.[meta.version] ?? new Date().toISOString(),
      repositoryUrl: meta.repository?.url ?? null,
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`npm registry timeout for ${dep} after ${config.npm.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchVersionsBetween(
  dep: string,
  fromVersion: string,
  toVersion: string,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.npm.timeoutMs);

  try {
    const resp = await fetch(`${config.npm.registryUrl}/${encodeURIComponent(dep)}`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "kiln-upgrade-bot/0.1.0" },
    });

    if (!resp.ok) throw new Error(`npm registry returned ${resp.status}`);

    const meta = (await resp.json()) as { versions?: Record<string, unknown> };
    const allVersions = Object.keys(meta.versions ?? {});

    // Simple semver comparison — filter versions > from and <= to
    return allVersions.filter((v) => compareSemver(v, fromVersion) > 0 && compareSemver(v, toVersion) <= 0);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`npm registry timeout for ${dep} after ${config.npm.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Simple semver comparison. Returns -1, 0, or 1. */
export function compareSemver(a: string, b: string): number {
  const parseV = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((n) => parseInt(n, 10));

  const [aMaj = 0, aMin = 0, aPatch = 0] = parseV(a);
  const [bMaj = 0, bMin = 0, bPatch = 0] = parseV(b);

  if (aMaj !== bMaj) return aMaj > bMaj ? 1 : -1;
  if (aMin !== bMin) return aMin > bMin ? 1 : -1;
  if (aPatch !== bPatch) return aPatch > bPatch ? 1 : -1;
  return 0;
}

log("debug", "npm registry client initialized", { registryUrl: config.npm.registryUrl });
