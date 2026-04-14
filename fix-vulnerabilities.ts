/**
 * Tool: fixVulnerabilities
 *
 * Attempts to fix vulnerability alerts across repos.
 *
 * Fix strategy (tried in order):
 *   1. Update the direct dependency that bundles the vulnerable transitive dep
 *   2. Add a package.json "overrides" entry to force the patched version
 *   3. If neither works, report back explaining why
 *
 * Flow:
 *   1. Clone only the affected repos
 *   2. For each vulnerability, attempt fixes in order
 *   3. Run npm install to verify the fix works
 *   4. Report what was done per repo
 *   5. Optionally create PRs
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadRepos, loadPolicy } from "../core/config.js";
import {
  cloneRepo,
  createBranch,
  commitAndPush,
  createPullRequest,
  GitHubError,
} from "../core/github.js";
import { fixReport } from "../core/report.js";
import { scanSingleRepo } from "./scan-vulnerabilities.js";
import type { FixResult, Repo, VulnerabilityResult } from "../core/models.js";

const execFileAsync = promisify(execFile);

function readPackageJson(repoPath: string): Record<string, unknown> {
  const filePath = path.join(repoPath, "package.json");
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writePackageJson(repoPath: string, data: Record<string, unknown>): void {
  const filePath = path.join(repoPath, "package.json");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

async function runNpmInstall(repoPath: string): Promise<{ success: boolean; error: string }> {
  try {
    await execFileAsync("npm", ["install"], { cwd: repoPath, timeout: 180_000 });
    return { success: true, error: "" };
  } catch (err: unknown) {
    const execError = err as { stderr?: string };
    return { success: false, error: execError.stderr ?? "Unknown npm error" };
  }
}

async function tryUpdateDirectDependency(
  repoPath: string,
  vuln: VulnerabilityResult,
): Promise<{ success: boolean; error: string }> {
  if (!vuln.directDependency || vuln.directDependency === "direct dependency" || vuln.directDependency === "unknown") {
    return { success: false, error: "Could not determine which direct dependency to update" };
  }

  try {
    await execFileAsync(
      "npm",
      ["install", `${vuln.directDependency}@latest`, "--save"],
      { cwd: repoPath, timeout: 180_000 },
    );
  } catch (err: unknown) {
    const execError = err as { stderr?: string };
    return {
      success: false,
      error: `npm install ${vuln.directDependency}@latest failed: ${execError.stderr ?? ""}`,
    };
  }

  // Verify the vulnerable version is gone from the lockfile
  const lockPath = path.join(repoPath, "package-lock.json");
  if (fs.existsSync(lockPath)) {
    const lockData = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    const packages = (lockData.packages ?? {}) as Record<string, { name?: string; version?: string }>;

    for (const [, info] of Object.entries(packages)) {
      let name = info.name ?? "";
      if (!name) continue;

      if (name === vuln.packageName && info.version === vuln.currentVersion) {
        return {
          success: false,
          error: `Updated ${vuln.directDependency} but ${vuln.packageName}@${vuln.currentVersion} still in lockfile`,
        };
      }
    }
  }

  return { success: true, error: "" };
}

async function tryAddOverride(
  repoPath: string,
  vuln: VulnerabilityResult,
): Promise<{ success: boolean; error: string }> {
  if (!vuln.patchedVersion) {
    return { success: false, error: `No patched version available for ${vuln.packageName}` };
  }

  const packageData = readPackageJson(repoPath);

  const overrides = (packageData.overrides ?? {}) as Record<string, string>;
  overrides[vuln.packageName] = vuln.patchedVersion;
  packageData.overrides = overrides;

  writePackageJson(repoPath, packageData);

  const installResult = await runNpmInstall(repoPath);

  if (!installResult.success) {
    return {
      success: false,
      error:
        `Override added for ${vuln.packageName}@${vuln.patchedVersion} ` +
        `but npm install failed: ${installResult.error}. ` +
        `This usually means the parent package pins an exact version ` +
        `internally and the override conflicts with it.`,
    };
  }

  return { success: true, error: "" };
}

async function fixSingleRepo(
  repo: Repo,
  vulnerabilities: VulnerabilityResult[],
  workDir: string,
): Promise<FixResult> {
  const branchName = `repokeeper/fix-vulnerabilities`;
  const changesMade: string[] = [];
  const failedFixes: string[] = [];

  let repoPath: string;
  try {
    repoPath = await cloneRepo(repo.org, repo.name, workDir);
    await createBranch(repoPath, branchName);
  } catch (err) {
    return {
      repoName: repo.name,
      branchName,
      success: false,
      strategy: "manual_required",
      changesMade: [],
      errorMessage: `Failed to clone or create branch: ${err}`,
      prUrl: "",
    };
  }

  for (const vuln of vulnerabilities) {
    // Strategy 1: Update the direct dependency
    const updateResult = await tryUpdateDirectDependency(repoPath, vuln);
    if (updateResult.success) {
      changesMade.push(`Updated ${vuln.directDependency} to latest`);
      continue;
    }

    // Strategy 2: Add an override
    const overrideResult = await tryAddOverride(repoPath, vuln);
    if (overrideResult.success) {
      changesMade.push(`Added override: ${vuln.packageName}@${vuln.patchedVersion}`);
      continue;
    }

    // Both strategies failed
    failedFixes.push(`${vuln.packageName}: ${overrideResult.error}`);
  }

  if (failedFixes.length > 0 && changesMade.length === 0) {
    return {
      repoName: repo.name,
      branchName,
      success: false,
      strategy: "manual_required",
      changesMade: [],
      errorMessage: failedFixes.join("\n"),
      prUrl: "",
    };
  }

  const strategy = changesMade.some((c) => c.toLowerCase().includes("override"))
    ? "add_override" as const
    : "update_direct_dependency" as const;

  return {
    repoName: repo.name,
    branchName,
    success: true,
    strategy,
    changesMade,
    errorMessage: failedFixes.join("\n"),
    prUrl: "",
  };
}

function buildPrBody(vulns: VulnerabilityResult[], result: FixResult): string {
  const lines = [
    "## Repokeeper: vulnerability fixes",
    "",
    "This PR was created by repokeeper.",
    "",
    "### Vulnerabilities addressed",
    "",
    ...vulns.map((v) => `- **${v.packageName}** (${v.severity}): ${v.detail}`),
    "",
    "### Changes made",
    "",
    ...result.changesMade.map((c) => `- ${c}`),
    "",
    "### Review checklist",
    "",
    "- [ ] CI passes",
    "- [ ] No breaking changes from dependency updates",
    "- [ ] Integration tests still green",
  ];
  return lines.join("\n");
}

/**
 * Fix vulnerabilities across specified repos and return a markdown report.
 */
export async function fixRepos(
  repoNames: string[],
  createPrs: boolean = false,
): Promise<string> {
  const repos = loadRepos();
  const policy = loadPolicy();
  const repoLookup = new Map(repos.map((r) => [r.name, r]));

  const allResults: FixResult[] = [];
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "repokeeper-"));

  try {
    for (const repoName of repoNames) {
      const repo = repoLookup.get(repoName);
      if (!repo) continue;

      // Re-scan this repo to get current vulnerabilities
      const vulns = await scanSingleRepo(repo, policy.maxVulnerabilitySeverity);
      if (vulns.length === 0) continue;

      const result = await fixSingleRepo(repo, vulns, workDir);

      if (result.success && createPrs) {
        try {
          const repoPath = path.join(workDir, repo.name);
          const commitMsg =
            `fix: resolve ${vulns.length} vulnerability alerts\n\n` +
            `Applied by repokeeper.\n` +
            `Changes: ${result.changesMade.join(", ")}`;

          await commitAndPush(repoPath, result.branchName, commitMsg);

          result.prUrl = await createPullRequest(
            repo.org,
            repo.name,
            result.branchName,
            `fix: resolve ${vulns.length} vulnerability alerts`,
            buildPrBody(vulns, result),
            repo.defaultBranch,
          );
        } catch (err) {
          result.errorMessage += `\nPR creation failed: ${err}`;
        }
      }

      allResults.push(result);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  return fixReport("Vulnerability fix results", allResults);
}
