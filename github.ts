/**
 * GitHub API wrapper using the gh CLI.
 *
 * All interactions with GitHub go through this module.
 * Uses `gh api` for reading data (fast, no cloning needed)
 * and `gh` commands for write operations (clone, PR creation).
 *
 * Requires: gh CLI installed and authenticated via SSO.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";

const execFileAsync = promisify(execFile);

export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

/**
 * Run a gh CLI command and return its stdout.
 */
export async function runGhCommand(
  args: string[],
  options: { timeout?: number; cwd?: string } = {},
): Promise<string> {
  const { timeout = 30_000, cwd } = options;

  try {
    const result = await execFileAsync("gh", args, { timeout, cwd });
    return result.stdout;
  } catch (error: unknown) {
    const execError = error as { stderr?: string; code?: string };

    if (execError.code === "ETIMEDOUT") {
      throw new GitHubError(`Command timed out after ${timeout}ms: gh ${args.join(" ")}`);
    }

    throw new GitHubError(
      `Command failed: gh ${args.join(" ")}\n${execError.stderr ?? "Unknown error"}`,
    );
  }
}

/**
 * Read a single file from a repo via the GitHub API.
 *
 * This does NOT clone the repo. It's a single HTTP request.
 */
export async function getFileContent(
  org: string,
  repo: string,
  filePath: string,
  ref?: string,
): Promise<string> {
  let endpoint = `/repos/${org}/${repo}/contents/${filePath}`;

  if (ref) {
    endpoint += `?ref=${ref}`;
  }

  let responseText: string;
  try {
    responseText = await runGhCommand(["api", endpoint]);
  } catch {
    throw new GitHubError(`Could not read ${org}/${repo}/${filePath}`);
  }

  const response = JSON.parse(responseText);

  if (!response.content) {
    throw new GitHubError(`No content in response for ${org}/${repo}/${filePath}`);
  }

  const contentBase64 = response.content.replace(/\n/g, "");
  return Buffer.from(contentBase64, "base64").toString("utf-8");
}

/**
 * Check if a file exists in a repo without downloading it.
 */
export async function fileExists(
  org: string,
  repo: string,
  filePath: string,
): Promise<boolean> {
  try {
    await getFileContent(org, repo, filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List files in a directory within a repo.
 */
export async function listDirectory(
  org: string,
  repo: string,
  directoryPath: string,
): Promise<Array<{ name: string; path: string; type: string }>> {
  try {
    const responseText = await runGhCommand([
      "api",
      `/repos/${org}/${repo}/contents/${directoryPath}`,
    ]);
    return JSON.parse(responseText);
  } catch {
    return [];
  }
}

/**
 * Get Dependabot vulnerability alerts for a repo.
 */
export async function getSecurityAdvisories(
  org: string,
  repo: string,
): Promise<unknown[]> {
  try {
    const responseText = await runGhCommand(
      [
        "api",
        `/repos/${org}/${repo}/dependabot/alerts?state=open&severity=moderate,high,critical`,
      ],
      { timeout: 60_000 },
    );
    return JSON.parse(responseText);
  } catch {
    return [];
  }
}

/**
 * Clone a repo to a local directory.
 *
 * Only used for write operations (fixing and creating PRs).
 * For read-only scanning, use getFileContent instead.
 */
export async function cloneRepo(
  org: string,
  repo: string,
  destination: string,
  branch?: string,
): Promise<string> {
  const repoPath = path.join(destination, repo);

  if (fs.existsSync(path.join(repoPath, ".git"))) {
    await execFileAsync("git", ["pull", "--ff-only"], {
      cwd: repoPath,
      timeout: 60_000,
    });
    return repoPath;
  }

  const args = ["repo", "clone", `${org}/${repo}`, repoPath];

  if (branch) {
    args.push("--", "--branch", branch);
  }

  await runGhCommand(args, { timeout: 120_000 });
  return repoPath;
}

/**
 * Create and check out a new branch in a cloned repo.
 */
export async function createBranch(
  repoPath: string,
  branchName: string,
): Promise<void> {
  await execFileAsync("git", ["checkout", "-b", branchName], { cwd: repoPath });
}

/**
 * Stage all changes, commit, and push to the remote.
 */
export async function commitAndPush(
  repoPath: string,
  branchName: string,
  commitMessage: string,
): Promise<void> {
  const commands: string[][] = [
    ["git", "add", "-A"],
    ["git", "commit", "-m", commitMessage],
    ["git", "push", "origin", branchName],
  ];

  for (const command of commands) {
    const [cmd, ...args] = command;
    const result = await execFileAsync(cmd, args, { cwd: repoPath });

    if (result.stderr && result.stderr.includes("fatal")) {
      throw new GitHubError(`Git command failed: ${command.join(" ")}\n${result.stderr}`);
    }
  }
}

/**
 * Create a pull request and return its URL.
 */
export async function createPullRequest(
  org: string,
  repo: string,
  branchName: string,
  title: string,
  body: string,
  baseBranch: string = "main",
): Promise<string> {
  const result = await runGhCommand([
    "pr",
    "create",
    "--repo",
    `${org}/${repo}`,
    "--head",
    branchName,
    "--base",
    baseBranch,
    "--title",
    title,
    "--body",
    body,
  ]);

  return result.trim();
}
