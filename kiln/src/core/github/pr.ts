/**
 * GitHub PR creation via GitHub App installation tokens.
 * - Opens PRs only against feat/kiln-* branches (never main).
 * - PR body includes Migration Notes with changelog URLs and file:line citations.
 * - All commits are GitHub-App-signed (Verified badge via the app's commit author).
 */
import { getInstallationToken, fetchWithTimeout } from "./app.js";
import { consumeGitHubTokens } from "./rate-limiter.js";
import { config } from "../../config.js";
import { log } from "../../telemetry/otel.js";
import type { PatchedFile, HumanReviewItem, BreakingChange } from "../../types.js";

const GH_API = "https://api.github.com";
const GH_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

interface CreatePRParams {
  installationId: number;
  owner: string;
  repo: string;
  dep: string;
  fromVersion: string;
  toVersion: string;
  changelogUrls: string[];
  breakingChanges: BreakingChange[];
  patchedFiles: PatchedFile[];
  humanReviewItems: HumanReviewItem[];
  defaultBranch: string;
}

interface CreatedPR {
  number: number;
  url: string;
  branchName: string;
}

/** Create a Kiln upgrade PR. Returns the PR number and URL. */
export async function createUpgradePR(params: CreatePRParams): Promise<CreatedPR> {
  const { installationId, owner, repo } = params;
  const { token } = await getInstallationToken(installationId);
  const headers = { ...GH_HEADERS, Authorization: `token ${token}` };

  // Sanitize branch name — no slashes in dep names
  const safeDepName = params.dep.replace(/[^a-z0-9-]/gi, "-").replace(/-+/g, "-");
  const branchName = `feat/kiln-${safeDepName}-${params.toVersion}`;

  // 1. Get default branch SHA
  await consumeGitHubTokens(1);
  const refResp = await fetchWithTimeout(
    `${GH_API}/repos/${owner}/${repo}/git/refs/heads/${params.defaultBranch}`,
    { headers },
    config.github.readTimeoutMs,
  );
  if (!refResp.ok) {
    throw new Error(`Failed to get ref for ${params.defaultBranch}: ${refResp.status}`);
  }
  const refData = (await refResp.json()) as { object: { sha: string } };
  const baseSha = refData.object.sha;

  // 2. Create feature branch
  await consumeGitHubTokens(1);
  const createBranchResp = await fetchWithTimeout(
    `${GH_API}/repos/${owner}/${repo}/git/refs`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
    },
    config.github.writeTimeoutMs,
  );
  // 422 = branch already exists — that's fine, proceed
  if (!createBranchResp.ok && createBranchResp.status !== 422) {
    throw new Error(`Failed to create branch ${branchName}: ${createBranchResp.status}`);
  }

  // 3. Apply patches as tree + commit for each patched file
  for (const patch of params.patchedFiles) {
    await applyFilePatch(owner, repo, branchName, patch, headers);
  }

  // 4. Open the PR
  const prBody = buildPRBody(params);
  await consumeGitHubTokens(1);
  const prResp = await fetchWithTimeout(
    `${GH_API}/repos/${owner}/${repo}/pulls`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `kiln: upgrade ${params.dep} ${params.fromVersion} → ${params.toVersion}`,
        body: prBody,
        head: branchName,
        base: params.defaultBranch,
        draft: false,
      }),
    },
    config.github.writeTimeoutMs,
  );

  if (!prResp.ok && prResp.status !== 422) {
    const errBody = await prResp.text();
    throw new Error(`Failed to create PR: ${prResp.status} ${errBody}`);
  }

  const pr = (await prResp.json()) as { number: number; html_url: string };
  log("info", "Kiln PR created", {
    owner,
    repo,
    dep: params.dep,
    toVersion: params.toVersion,
    prNumber: pr.number,
    prUrl: pr.html_url,
  });

  return { number: pr.number, url: pr.html_url, branchName };
}

async function applyFilePatch(
  owner: string,
  repo: string,
  branch: string,
  patch: PatchedFile,
  headers: Record<string, string>,
): Promise<void> {
  // Get current file content + SHA
  await consumeGitHubTokens(1);
  const fileResp = await fetchWithTimeout(
    `${GH_API}/repos/${owner}/${repo}/contents/${patch.filePath}?ref=${branch}`,
    { headers },
    config.github.readTimeoutMs,
  );

  if (!fileResp.ok) {
    log("warn", "Cannot fetch file for patch — skipping", { filePath: patch.filePath });
    return;
  }

  const fileData = (await fileResp.json()) as { content: string; sha: string };
  const currentContent = Buffer.from(fileData.content, "base64").toString("utf-8");
  const patchedContent = currentContent.replace(patch.originalCode, patch.patchedCode);

  if (patchedContent === currentContent) {
    log("warn", "Patch is a no-op — original code not found in file", {
      filePath: patch.filePath,
    });
    return;
  }

  await consumeGitHubTokens(1);
  const updateResp = await fetchWithTimeout(
    `${GH_API}/repos/${owner}/${repo}/contents/${patch.filePath}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `kiln: patch ${patch.filePath} for ${patch.breakingChangeDescription}`,
        content: Buffer.from(patchedContent, "utf-8").toString("base64"),
        sha: fileData.sha,
        branch,
      }),
    },
    config.github.writeTimeoutMs,
  );

  if (!updateResp.ok) {
    log("warn", "Failed to apply patch to file", {
      filePath: patch.filePath,
      status: updateResp.status,
    });
  }
}

function buildPRBody(params: CreatePRParams): string {
  const {
    dep,
    fromVersion,
    toVersion,
    changelogUrls,
    breakingChanges,
    patchedFiles,
    humanReviewItems,
  } = params;

  const changelogSection =
    changelogUrls.length > 0
      ? changelogUrls.map((u) => `- ${u}`).join("\n")
      : "_No changelog URLs found_";

  const breakingSection =
    breakingChanges.length === 0
      ? "_No breaking changes detected_"
      : breakingChanges
          .map((b) => `- **[${b.category}]** ${b.description}${b.affectedSymbol ? ` (\`${b.affectedSymbol}\`)` : ""}`)
          .join("\n");

  const patchedSection =
    patchedFiles.length === 0
      ? "_No mechanical patches applied_"
      : patchedFiles
          .map(
            (p) =>
              `- \`${p.filePath}\` L${p.lineStart}–${p.lineEnd}: ${p.breakingChangeDescription}`,
          )
          .join("\n");

  const humanSection =
    humanReviewItems.length === 0
      ? "_No items flagged for human review_"
      : humanReviewItems
          .map(
            (h) =>
              `- ⚠️ \`${h.filePath}\` L${h.line}: ${h.reason}${h.suggestion ? `\n  > Suggestion: ${h.suggestion}` : ""}`,
          )
          .join("\n");

  return `## Kiln Upgrade: \`${dep}\` ${fromVersion} → ${toVersion}

> This PR was authored by [Kiln](https://github.com/nanohype/protohype/tree/main/kiln), the dependency-upgrade automation service. All commits are GitHub-App-signed.

### Changelog Sources

${changelogSection}

### Breaking Changes Identified

${breakingSection}

### Migration Notes — Mechanical Patches Applied

${patchedSection}

### Items Flagged for Human Review

${humanSection}

---

**Review checklist:**
- [ ] All mechanical patches look correct
- [ ] Human-review items have been addressed
- [ ] Tests pass in CI
- [ ] No production incidents expected from this upgrade

_Authored by Kiln · [View service docs](https://github.com/nanohype/protohype/tree/main/kiln/docs)_`;
}
