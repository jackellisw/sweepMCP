/**
 * Tool: scanNodeVersions
 *
 * Scans all repos to find every place a Node version is referenced
 * and reports whether each is up to date with the target version.
 *
 * Checks:
 *   - .nvmrc
 *   - package.json engines.node
 *   - CDK stack files (Runtime.NODEJS_XX_X)
 *   - .github/workflows/*.yml (setup-node)
 *   - Dockerfile (FROM node:XX)
 *   - buildspec.yml (nodejs runtime)
 *
 * All reads are via the GitHub API. No repos are cloned.
 */

import { loadRepos, loadPolicy } from "../core/config.js";
import { getFileContent, listDirectory } from "../core/github.js";
import { nodeScanReport } from "../core/report.js";
import type { NodeScanResult, NodeVersionLocation, Repo } from "../core/models.js";

/**
 * Extract the major version number from various formats.
 * Handles: "20", "v20", "20.11.0", ">=20", "^20.0.0", "lts/*"
 */
function extractMajorVersion(versionString: string): string {
  const cleaned = versionString.trim().replace(/^[v>=^~]+/, "");

  if (cleaned.startsWith("lts")) {
    return "lts";
  }

  const match = cleaned.match(/^(\d+)/);
  return match ? match[1] : cleaned;
}

async function checkNvmrc(repo: Repo): Promise<NodeVersionLocation | null> {
  try {
    const content = await getFileContent(repo.org, repo.name, ".nvmrc");
    return {
      filePath: ".nvmrc",
      currentVersion: content.trim(),
      lineContent: content.trim(),
    };
  } catch {
    return null;
  }
}

async function checkPackageJsonEngines(repo: Repo): Promise<NodeVersionLocation | null> {
  try {
    const content = await getFileContent(repo.org, repo.name, "package.json");
    const data = JSON.parse(content);
    const enginesNode = data?.engines?.node;

    if (enginesNode) {
      return {
        filePath: "package.json (engines.node)",
        currentVersion: enginesNode,
        lineContent: `"node": "${enginesNode}"`,
      };
    }
  } catch {
    // No package.json or no engines field
  }
  return null;
}

async function checkCdkFiles(repo: Repo): Promise<NodeVersionLocation[]> {
  const locations: NodeVersionLocation[] = [];
  const cdkDirs = ["lib", "src", "infrastructure", "cdk"];
  const runtimePattern = /Runtime\.NODEJS_(\d+)_X/gi;

  for (const dirName of cdkDirs) {
    let files: Array<{ name: string; path: string; type: string }>;
    try {
      files = await listDirectory(repo.org, repo.name, dirName);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.name.endsWith(".ts") && !file.name.endsWith(".js")) {
        continue;
      }

      let content: string;
      try {
        content = await getFileContent(repo.org, repo.name, file.path);
      } catch {
        continue;
      }

      let match: RegExpExecArray | null;
      runtimePattern.lastIndex = 0;

      while ((match = runtimePattern.exec(content)) !== null) {
        locations.push({
          filePath: file.path,
          currentVersion: match[1],
          lineContent: match[0],
        });
      }
    }
  }

  return locations;
}

async function checkGithubWorkflows(repo: Repo): Promise<NodeVersionLocation[]> {
  const locations: NodeVersionLocation[] = [];

  let files: Array<{ name: string; path: string; type: string }>;
  try {
    files = await listDirectory(repo.org, repo.name, ".github/workflows");
  } catch {
    return locations;
  }

  const nodeVersionPattern = /node-version:\s*['"]?(\d+[\d.x]*)['"]?/g;

  for (const file of files) {
    if (!file.name.endsWith(".yml") && !file.name.endsWith(".yaml")) {
      continue;
    }

    let content: string;
    try {
      content = await getFileContent(repo.org, repo.name, file.path);
    } catch {
      continue;
    }

    let match: RegExpExecArray | null;
    nodeVersionPattern.lastIndex = 0;

    while ((match = nodeVersionPattern.exec(content)) !== null) {
      locations.push({
        filePath: file.path,
        currentVersion: match[1],
        lineContent: match[0].trim(),
      });
    }
  }

  return locations;
}

async function checkDockerfile(repo: Repo): Promise<NodeVersionLocation | null> {
  try {
    const content = await getFileContent(repo.org, repo.name, "Dockerfile");
    const match = content.match(/FROM\s+node:(\d+[\d.\-a-z]*)/i);

    if (match) {
      return {
        filePath: "Dockerfile",
        currentVersion: match[1],
        lineContent: match[0],
      };
    }
  } catch {
    // No Dockerfile
  }
  return null;
}

async function checkBuildspec(repo: Repo): Promise<NodeVersionLocation | null> {
  try {
    const content = await getFileContent(repo.org, repo.name, "buildspec.yml");
    const match = content.match(/nodejs:\s*(\d+[\d.]*)/);

    if (match) {
      return {
        filePath: "buildspec.yml",
        currentVersion: match[1],
        lineContent: match[0].trim(),
      };
    }
  } catch {
    // No buildspec
  }
  return null;
}

export async function scanSingleRepo(
  repo: Repo,
  targetVersion: string,
): Promise<NodeScanResult> {
  const locations: NodeVersionLocation[] = [];

  const nvmrc = await checkNvmrc(repo);
  if (nvmrc) locations.push(nvmrc);

  const engines = await checkPackageJsonEngines(repo);
  if (engines) locations.push(engines);

  const cdkLocations = await checkCdkFiles(repo);
  locations.push(...cdkLocations);

  const workflowLocations = await checkGithubWorkflows(repo);
  locations.push(...workflowLocations);

  const dockerfile = await checkDockerfile(repo);
  if (dockerfile) locations.push(dockerfile);

  const buildspec = await checkBuildspec(repo);
  if (buildspec) locations.push(buildspec);

  // Check if any location is behind the target
  const needsUpdate = locations.some((location) => {
    const major = extractMajorVersion(location.currentVersion);
    return major !== targetVersion && major !== "lts";
  });

  return {
    repoName: repo.name,
    locations,
    needsUpdate,
  };
}

/**
 * Scan all repos for Node version compliance and return a markdown report.
 */
export async function scanAllRepos(maxWorkers: number = 5): Promise<string> {
  const repos = loadRepos();
  const policy = loadPolicy();
  const target = policy.targetNodeVersion;

  const allResults: NodeScanResult[] = [];

  for (let i = 0; i < repos.length; i += maxWorkers) {
    const batch = repos.slice(i, i + maxWorkers);

    const batchResults = await Promise.allSettled(
      batch.map((repo) => scanSingleRepo(repo, target)),
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        allResults.push(result.value);
      }
    }
  }

  return nodeScanReport(allResults, target);
}
