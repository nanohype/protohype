// GitHub App adapter. Owns installation-token minting (with DDB-backed cache),
// file/branch/PR operations, and code search.

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { CodeSearchPort, GithubAppPort } from "../../core/ports.js";
import type { GithubTokenCache } from "../dynamodb/github-token-cache.js";
import { err, ok, type CallSite, type InstallationId, type PrRef, type PrSpec } from "../../types.js";

export interface GithubAppAdapterConfig {
  appId: number;
  privateKeyPem: string;
  timeoutMs: number;
}

export function makeGithubAppAdapter(
  cfg: GithubAppAdapterConfig,
  tokenCache: GithubTokenCache,
): GithubAppPort {
  const auth = createAppAuth({ appId: cfg.appId, privateKey: cfg.privateKeyPem });
  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`github timeout ${cfg.timeoutMs}ms`)), cfg.timeoutMs),
      ),
    ]);

  const clientFor = async (installationId: InstallationId): Promise<Octokit> => {
    const cached = await tokenCache.get(installationId);
    if (cached) return new Octokit({ auth: cached.token });
    const minted = await withTimeout(
      auth({ type: "installation", installationId }),
    );
    const token = (minted as { token: string; expiresAt: string }).token;
    const expiresAt = new Date((minted as { expiresAt: string }).expiresAt);
    await tokenCache.put(installationId, token, expiresAt);
    return new Octokit({ auth: token });
  };

  return {
    async getInstallationToken(installationId) {
      try {
        const cached = await tokenCache.get(installationId);
        if (cached) return ok(cached);
        const minted = await withTimeout(auth({ type: "installation", installationId }));
        const token = (minted as { token: string; expiresAt: string }).token;
        const expiresAt = new Date((minted as { expiresAt: string }).expiresAt);
        await tokenCache.put(installationId, token, expiresAt);
        return ok({ token, expiresAt });
      } catch (e) {
        return err({ kind: "Upstream", source: "github-app:token", message: asMessage(e) });
      }
    },

    async getFile(installationId, owner, repo, path, ref) {
      try {
        const octo = await clientFor(installationId);
        const resp = await withTimeout(
          octo.repos.getContent({ owner, repo, path, ref }),
        );
        const data = resp.data;
        if (Array.isArray(data) || data.type !== "file") {
          return err({ kind: "NotFound", what: `${owner}/${repo}:${path}@${ref}` });
        }
        const content = Buffer.from(data.content, "base64").toString("utf8");
        return ok({ sha: data.sha, content });
      } catch (e) {
        return err({ kind: "Upstream", source: "github-app:getFile", message: asMessage(e) });
      }
    },

    async headSha(installationId, owner, repo, ref) {
      try {
        const octo = await clientFor(installationId);
        const resp = await withTimeout(octo.repos.getBranch({ owner, repo, branch: ref }));
        return ok(resp.data.commit.sha);
      } catch (e) {
        return err({ kind: "Upstream", source: "github-app:headSha", message: asMessage(e) });
      }
    },

    async openPullRequest(installationId, spec: PrSpec) {
      try {
        const octo = await clientFor(installationId);
        const baseRef = await withTimeout(
          octo.repos.getBranch({ owner: spec.owner, repo: spec.repo, branch: spec.baseBranch }),
        );
        const baseSha = baseRef.data.commit.sha;

        await withTimeout(
          octo.git.createRef({
            owner: spec.owner,
            repo: spec.repo,
            ref: `refs/heads/${spec.headBranch}`,
            sha: baseSha,
          }),
        );

        // One commit per file. A multi-file tree+commit would be cleaner; this
        // is simpler and acceptable for v1 given patches are usually small.
        let latestSha = baseSha;
        for (const file of spec.files) {
          const existing = await withTimeout(
            octo.repos
              .getContent({ owner: spec.owner, repo: spec.repo, path: file.path, ref: spec.headBranch })
              .catch(() => null),
          );
          const existingSha =
            existing && !Array.isArray((existing as { data?: unknown }).data)
              ? (((existing as { data: { sha?: string } }).data.sha) ?? undefined)
              : undefined;
          const params: Parameters<Octokit["repos"]["createOrUpdateFileContents"]>[0] = {
            owner: spec.owner,
            repo: spec.repo,
            path: file.path,
            message: `kiln: patch ${file.path}`,
            content: Buffer.from(file.after, "utf8").toString("base64"),
            branch: spec.headBranch,
            ...(existingSha ? { sha: existingSha } : {}),
          };
          const written = await withTimeout(octo.repos.createOrUpdateFileContents(params));
          const commit = written.data.commit;
          if (commit?.sha) latestSha = commit.sha;
        }

        const pr = await withTimeout(
          octo.pulls.create({
            owner: spec.owner,
            repo: spec.repo,
            title: spec.title,
            body: spec.body,
            base: spec.baseBranch,
            head: spec.headBranch,
          }),
        );

        const ref: PrRef = {
          owner: spec.owner,
          repo: spec.repo,
          number: pr.data.number,
          url: pr.data.html_url,
          headSha: latestSha,
        };
        return ok(ref);
      } catch (e) {
        return err({ kind: "Upstream", source: "github-app:openPr", message: asMessage(e) });
      }
    },
  };
}

export function makeCodeSearchAdapter(
  githubApp: GithubAppPort,
  timeoutMs: number,
): CodeSearchPort {
  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`github timeout ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

  return {
    async searchImportSites(installationId, owner, repo, pkg, symbols) {
      try {
        const tokenResult = await githubApp.getInstallationToken(installationId);
        if (!tokenResult.ok) return tokenResult;
        const octo = new Octokit({ auth: tokenResult.value.token });

        // One query per symbol; GitHub code search doesn't support OR across
        // identifiers reliably. Capped at 10 sites per symbol to stay cheap.
        const sites: CallSite[] = [];
        const symbolList = symbols.length > 0 ? symbols : [pkg];
        for (const sym of symbolList) {
          const q = `${sym} in:file language:TypeScript repo:${owner}/${repo}`;
          const resp = await withTimeout(
            octo.search.code({ q, per_page: 10 }),
          );
          for (const item of resp.data.items) {
            sites.push({
              repo: `${owner}/${repo}`,
              path: item.path,
              line: 0,
              symbol: sym,
              snippet: item.text_matches?.[0]?.fragment ?? "",
            });
          }
        }
        return ok(sites);
      } catch (e) {
        return err({ kind: "Upstream", source: "github-app:search", message: asMessage(e) });
      }
    },
  };
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
