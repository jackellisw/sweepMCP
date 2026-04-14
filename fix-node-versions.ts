/**
 * Tool: fixNodeVersions
 *
 * Fixes Node version references across all locations in affected repos.
 *
 * Updates:
 *   - .nvmrc
 *   - package.json engines.node
 *   - CDK Runtime.NODEJS_XX_X
 *   - GitHub Actions setup-node version
 *   - Dockerfile FROM node:XX
 *   - buildspec.yml nodejs version
 *
 * Flow:
 *   1. Clone only repos that need updating
 *   2. Create a branch
 *   3. Update every file where the old Node version appears
 *   4. Run npm install to regenerate the lockfile
 *   5. If npm install fails, report what broke
 *   6. Optionally create PRs
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
import { scanSingleRepo } from "./scan-node-versions.js";
import type { FixResult, NodeScanResult, Repo } from "../core/models.js";

const execFileAsync = promisify(execFile);

function updateNvmrc(repoPath: string, targetVersion: string): boolean {
  const nvmrcPath = path.join(repoPath, ".nvmrc");
  if (!fs.existsSync(nvmrcPath)) return false;

  fs.writeFileSync(nvmrcPath, `v${targetVersion}\n`);
  return true;
}

function updatePackageJsonEngines(repoPath: string, targetVersion: string): boolean {
  const packagePath = path.join(repoPath, "package.json");
  if (!fs.existsSync(packagePath)) return false;

  const data = JSON.parse(fs.readFileSync(packagePath, "utf-8"));

  if (!data.engines?.node) return false;

  data.engines.node = `>=${targetVersion}`;
  fs.writeFileSync(packagePath, JSON.stringify(data, null, 2) + "\n");
  return true;
}

function updateCdkRuntime(
  repoPath: string,
  oldVersion: string,
  targetVersion: string,
): string[] {
  const updatedFiles: string[] = [];
  const oldPattern = `Runtime.NODEJS_${oldVersion}_X`;
  const newPattern = `Runtime.NODEJS_${targetVersion}_X`;

  const cdkDirs = ["lib", "src", "infrastructure", "cdk"];

  for (const dirName of cdkDirs) {
    const dirPath = path.join(repoPath, dirName);
    if (!fs.existsSync(dirPath)) continue;

    const files = findFilesRecursive(dirPath, [".ts", ".js"]);

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, "utf-8");

      if (content.includes(oldPattern)) {
        fs.writeFileSync(filePath, content.replaceAll(oldPattern, newPattern));
        updatedFiles.push(path.relative(repoPath, filePath));
      }
    }
  }

  return updatedFiles;
}

function updateGithubWorkflows(
  repoPath: string,
  oldVersion: string,
  targetVersion: string,
): string[] {
  const updatedFiles: string[] = [];
  const workflowsDir = path.join(repoPath, ".github", "workflows");

  if (!fs.existsSync(workflowsDir)) return updatedFiles;

  const pattern = new RegExp(
    `(node-version:\\s*['"]?)${escapeRegex(oldVersion)}(['"]?)`,
    "g",
  );

  const files = fs.readdirSync(workflowsDir).filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );

  for (const fileName of files) {
    const filePath = path.join(workflowsDir, fileName);
    const content = fs.readFileSync(filePath, "utf-8");
    const newContent = content.replace(pattern, `$1${targetVersion}$2`);

    if (newContent !== content) {
      fs.writeFileSync(filePath, newContent);
      updatedFiles.push(path.relative(repoPath, filePath));
    }
  }

  return updatedFiles;
}

function updateDockerfile(
  repoPath: string,
  oldVersion: string,
  targetVersion: string,
): boolean {
  const dockerfilePath = path.join(repoPath, "Dockerfile");
  if (!fs.existsSync(dockerfilePath)) return false;

  const content = fs.readFileSync(dockerfilePath, "utf-8");
  const pattern = new RegExp(`(FROM\\s+node:)${escapeRegex(oldVersion)}`);
  const newContent = content.replace(pattern, `$1${targetVersion}`);

  if (newContent === content) return false;

  fs.writeFileSync(dockerfilePath, newContent);
  return true;
}

function updateBuildspec(
  repoPath: string,
  oldVersion: string,
  targetVersion: string,
): boolean {
  const buildspecPath = path.join(repoPath, "buildspec.yml");
  if (!fs.existsSync(buildspecPath)) return false;

  const content = fs.readFileSync(buildspecPath, "utf-8");
  const pattern = new RegExp(`(nodejs:\\s*)${escapeRegex(oldVersion)}`);
  const newContent = content.replace(pattern, `$1${targetVersion}`);

  if (newContent === content) return false;

  fs.writeFileSync(buildspecPath, newContent);
  return true;
}

async function runNpmInstall(
  repoPath: string,
): Promise<{ success: boolean; error: string }> {
  try {
    await execFileAsync("npm", ["install"], { cwd: repoPath, timeout: 180_000 });
    return { success: true, error: "" };
  } catch (err: unknown) {
    const execError = err as { stderr?: string };
    return { success: false, error: execError.stderr ?? "Unknown npm error" };
  }
}

/**
 * Figure out the current (old) Node major version from scan results.
 * Takes the most common version across all locations.
 */
function detectOldVersion(scanResult: NodeScanResult): string {
  const versionCounts = new Map<string, number>();

  for (const location of scanResult.locations) {
    const cleaned = location.currentVersion.trim().replace(/^[v>=^~]+/, "");
    const major = cleaned.includes(".") ? cleaned.split(".")[0] : cleaned;
    versionCounts.set(major, (versionCounts.get(major) ?? 0) + 1);
  }

  if (versionCounts.size === 0) return "";

  let maxVersion = "";
  let maxCount = 0;

  for (const [version, count] of versionCounts) {
    if (count > maxCount) {
      maxVersion = version;
      maxCount = count;
    }
  }

  return maxVersion;
}

async function fixSingleRepo(
  repo: Repo,
  scanResult: NodeScanResult,
  targetVersion: string,
  workDir: string,
): Promise<FixResult> {
  const branchName = `repokeeper/node-${targetVersion}-upgrade`;
  const changesMade: string[] = [];

  const oldVersion = detectOldVersion(scanResult);
  if (!oldVersion) {
    return {
      repoName: repo.name,
      branchName,
      success: false,
      strategy: "manual_required",
      changesMade: [],
      errorMessage: "Could not determine current Node version from scan results",
      prUrl: "",
    };
  }

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

  // Apply all updates
  if (updateNvmrc(repoPath, targetVersion)) {
    changesMade.push(".nvmrc");
  }

  if (updatePackageJsonEngines(repoPath, targetVersion)) {
    changesMade.push("package.json engines");
  }

  const cdkFiles = updateCdkRuntime(repoPath, oldVersion, targetVersion);
  for (const file of cdkFiles) {
    changesMade.push(`CDK runtime in ${file}`);
  }

  const workflowFiles = updateGithubWorkflows(repoPath, oldVersion, targetVersion);
  for (const file of workflowFiles) {
    changesMade.push(`setup-node in ${file}`);
  }

  if (updateDockerfile(repoPath, oldVersion, targetVersion)) {
    changesMade.push("Dockerfile");
  }

  if (updateBuildspec(repoPath, oldVersion, targetVersion)) {
    changesMade.push("buildspec.yml");
  }

  if (changesMade.length === 0) {
    return {
      repoName: repo.name,
      branchName,
      success: false,
      strategy: "manual_required",
      changesMade: [],
      errorMessage: "No files needed updating",
      prUrl: "",
    };
  }

  // Run npm install to regenerate lockfile
  const installResult = await runNpmInstall(repoPath);

  if (!installResult.success) {
    return {
      repoName: repo.name,
      branchName,
      success: false,
      strategy: "manual_required",
      changesMade,
      errorMessage:
        `Files were updated but npm install failed. ` +
        `This usually means a dependency doesn't support Node ${targetVersion} yet.\n\n` +
        `npm error: ${installResult.error}`,
      prUrl: "",
    };
  }

  return {
    repoName: repo.name,
    branchName,
    success: true,
    strategy: "update_direct_dependency",
    changesMade,
    errorMessage: "",
    prUrl: "",
  };
}

function buildPrBody(targetVersion: string, result: FixResult): string {
  const lines = [
    `## Repokeeper: Node.js v${targetVersion} upgrade`,
    "",
    "This PR was created by repokeeper.",
    "",
    "### Files updated",
    "",
    ...result.changesMade.map((c) => `- ${c}`),
    "",
    "### Review checklist",
    "",
    "- [ ] CI passes",
    `- [ ] Application works correctly on Node ${targetVersion}`,
    "- [ ] No deprecated API warnings in logs",
    "- [ ] Integration tests still green",
  ];
  return lines.join("\n");
}

/**
 * Fix Node versions across specified repos and return a markdown report.
 */
export async function fixRepos(
  repoNames: string[],
  createPrs: boolean = false,
): Promise<string> {
  const repos = loadRepos();
  const policy = loadPolicy();
  const target = policy.targetNodeVersion;
  const repoLookup = new Map(repos.map((r) => [r.name, r]));

  const allResults: FixResult[] = [];
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "repokeeper-"));

  try {
    for (const repoName of repoNames) {
      const repo = repoLookup.get(repoName);
      if (!repo) continue;

      // Re-scan to get current Node version locations
      const scanResult = await scanSingleRepo(repo, target);
      if (!scanResult.needsUpdate) continue;

      const result = await fixSingleRepo(repo, scanResult, target, workDir);

      if (result.success && createPrs) {
        try {
          const repoPath = path.join(workDir, repo.name);
          const commitMsg =
            `chore: upgrade Node.js to v${target}\n\n` +
            `Updated: ${result.changesMade.join(", ")}\n` +
            `Applied by repokeeper.`;

          await commitAndPush(repoPath, result.branchName, commitMsg);

          result.prUrl = await createPullRequest(
            repo.org,
            repo.name,
            result.branchName,
            `chore: upgrade Node.js to v${target}`,
            buildPrBody(target, result),
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

  return fixReport(`Node ${target} upgrade results`, allResults);
}

// ─── Helpers ─────────────────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findFilesRecursive(dir: string, extensions: string[]): string[] {
  const results: string[] = [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory() && entry.name !== "node_modules") {
      results.push(...findFilesRecursive(fullPath, extensions));
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }

  return results;
}
