/**
 * Tool: scanVulnerabilities
 *
 * Scans all repos for moderate, high, and critical vulnerability alerts
 * using the GitHub Dependabot API. Does not clone any repos.
 *
 * Flow:
 *   1. Load repo inventory
 *   2. For each repo, fetch open Dependabot alerts via gh api
 *   3. Filter to moderate severity and above
 *   4. Build a markdown report
 */

import { loadRepos, loadPolicy } from "../core/config.js";
import { getSecurityAdvisories } from "../core/github.js";
import { vulnerabilityScanReport } from "../core/report.js";
import type { Repo, Severity, VulnerabilityResult } from "../core/models.js";

const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

function parseSeverity(value: string): Severity | null {
  const mapping: Record<string, Severity> = {
    low: "low",
    moderate: "moderate",
    medium: "moderate",
    high: "high",
    critical: "critical",
  };
  return mapping[value.toLowerCase()] ?? null;
}

function isAboveThreshold(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}

function extractCveId(advisory: Record<string, unknown>): string {
  const identifiers = (advisory.identifiers ?? []) as Array<{
    type: string;
    value: string;
  }>;

  for (const id of identifiers) {
    if (id.type === "CVE") {
      return id.value;
    }
  }
  return "";
}

export async function scanSingleRepo(
  repo: Repo,
  threshold: Severity,
): Promise<VulnerabilityResult[]> {
  const results: VulnerabilityResult[] = [];

  const alerts = await getSecurityAdvisories(repo.org, repo.name);

  if (!Array.isArray(alerts)) {
    return results;
  }

  for (const alert of alerts) {
    const record = alert as Record<string, unknown>;
    const advisory = (record.security_advisory ?? {}) as Record<string, unknown>;
    const vulnerability = (record.security_vulnerability ?? {}) as Record<string, unknown>;
    const dependency = (record.dependency ?? {}) as Record<string, unknown>;

    const severityStr = (advisory.severity as string) ?? "";
    const severity = parseSeverity(severityStr);

    if (severity === null || !isAboveThreshold(severity, threshold)) {
      continue;
    }

    const packageInfo = (vulnerability.package ?? {}) as Record<string, unknown>;
    const firstPatched = (vulnerability.first_patched_version ?? null) as Record<
      string,
      unknown
    > | null;
    const depPackage = (dependency.package ?? {}) as Record<string, unknown>;

    results.push({
      repoName: repo.name,
      packageName: (packageInfo.name as string) ?? "unknown",
      currentVersion: (vulnerability.vulnerable_version_range as string) ?? "",
      severity,
      patchedVersion: firstPatched
        ? (firstPatched.identifier as string) ?? ""
        : "",
      cveId: extractCveId(advisory),
      directDependency: (depPackage.name as string) ?? "direct",
      detail: (advisory.summary as string) ?? "",
    });
  }

  return results;
}

/**
 * Scan all repos for vulnerabilities and return a markdown report.
 */
export async function scanAllRepos(maxWorkers: number = 5): Promise<string> {
  const repos = loadRepos();
  const policy = loadPolicy();
  const threshold = policy.maxVulnerabilitySeverity;

  const allResults: VulnerabilityResult[] = [];

  // Process in batches to avoid hammering the API
  for (let i = 0; i < repos.length; i += maxWorkers) {
    const batch = repos.slice(i, i + maxWorkers);

    const batchResults = await Promise.allSettled(
      batch.map((repo) => scanSingleRepo(repo, threshold)),
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        allResults.push(...result.value);
      }
    }
  }

  return vulnerabilityScanReport(allResults);
}
