// npm registry adapter. Public registry, JSON packument, explicit timeout.

import type { NpmRegistryPort } from "../../core/ports.js";
import { err, ok } from "../../types.js";

export interface NpmRegistryConfig {
  timeoutMs: number;
  userAgent: string;
  registryUrl: string;
}

interface NpmPackument {
  "dist-tags"?: { latest?: string };
  time?: Record<string, string>;
  versions?: Record<
    string,
    {
      repository?: string | { url?: string };
      homepage?: string;
    }
  >;
}

export function makeNpmRegistryAdapter(cfg: NpmRegistryConfig): NpmRegistryPort {
  const fetchJson = async <T>(url: string): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": cfg.userAgent, accept: "application/json" },
      });
      if (!resp.ok) throw new Error(`npm ${resp.status} ${resp.statusText}`);
      return (await resp.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async getLatestVersion(pkg) {
      try {
        const packument = await fetchJson<NpmPackument>(
          `${cfg.registryUrl}/${encodeURIComponent(pkg).replace("%40", "@")}`,
        );
        const version = packument["dist-tags"]?.latest;
        if (!version) return err({ kind: "NotFound", what: `npm:${pkg}:dist-tag.latest` });
        const publishedAt = packument.time?.[version] ?? new Date().toISOString();
        return ok({ version, publishedAt });
      } catch (e) {
        return err({ kind: "Upstream", source: "npm", message: asMessage(e) });
      }
    },
    async getVersionManifest(pkg, version) {
      try {
        const packument = await fetchJson<NpmPackument>(
          `${cfg.registryUrl}/${encodeURIComponent(pkg).replace("%40", "@")}`,
        );
        const entry = packument.versions?.[version];
        if (!entry) return err({ kind: "NotFound", what: `npm:${pkg}@${version}` });
        const repoField = entry.repository;
        const repository =
          typeof repoField === "string" ? repoField : repoField?.url;
        const manifest: { repository?: string; homepage?: string } = {};
        if (repository !== undefined) manifest.repository = repository;
        if (entry.homepage !== undefined) manifest.homepage = entry.homepage;
        return ok(manifest);
      } catch (e) {
        return err({ kind: "Upstream", source: "npm", message: asMessage(e) });
      }
    },
  };
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
