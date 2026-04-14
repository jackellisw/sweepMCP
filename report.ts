/**
 * Markdown report generator for repokeeper.
 *
 * Every tool produces a markdown report as its output.
 * This module provides helper functions to build those reports consistently.
 */

import type {
  FixResult,
  NodeScanResult,
  VulnerabilityResult,
} from "./models.js";

function header(title: string): string {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return `# ${title}\n\n_Generated: ${timestamp}_\n\n`;
}

export function vulnerabilityScanReport(results: VulnerabilityResult[]): string {
  if (results.length === 0) {
    return header("Vulnerability scan") + "No vulnerabilities found above threshold.\n";
  }

  const lines: string[] = [header("Vulnerability scan")];

  const repoNames = [...new Set(results.map((r) => r.repoName))].sort();
  lines.push(
    `**${results.length}** vulnerabilities found across **${repoNames.length}** repos.\n\n`,
  );

  lines.push("| Repo | Package | Current | Patched | Severity | Pulled in by |");
  lines.push("|------|---------|---------|---------|----------|--------------|");

  const sorted = [...results].sort((a, b) =>
    a.repoName.localeCompare(b.repoName),
  );

  for (const result of sorted) {
    const patched = result.patchedVersion || "No fix yet";
    lines.push(
      `| ${result.repoName} ` +
        `| ${result.packageName} ` +
        `| ${result.currentVersion} ` +
        `| ${patched} ` +
        `| ${result.severity} ` +
        `| ${result.directDependency} |`,
    );
  }

  return lines.join("\n") + "\n";
}

export function specificVulnerabilityReport(
  packageName: string,
  version: string,
  results: VulnerabilityResult[],
): string {
  const lines: string[] = [header(`Scan for ${packageName}@${version}`)];

  if (results.length === 0) {
    lines.push(
      `No repos contain \`${packageName}@${version}\` in their dependency tree.\n`,
    );
    return lines.join("\n");
  }

  const repoNames = [...new Set(results.map((r) => r.repoName))].sort();
  lines.push(`Found in **${repoNames.length}** repos:\n\n`);

  lines.push("| Repo | Pulled in by | Severity |");
  lines.push("|------|--------------|----------|");

  for (const result of results) {
    lines.push(
      `| ${result.repoName} | ${result.directDependency} | ${result.severity} |`,
    );
  }

  return lines.join("\n") + "\n";
}

export function nodeScanReport(
  results: NodeScanResult[],
  targetVersion: string,
): string {
  const lines: string[] = [header(`Node version scan (target: ${targetVersion})`)];

  const needsUpdate = results.filter((r) => r.needsUpdate);
  const upToDate = results.filter((r) => !r.needsUpdate);

  lines.push(
    `**${needsUpdate.length}** repos need updating, ` +
      `**${upToDate.length}** are up to date.\n\n`,
  );

  if (needsUpdate.length > 0) {
    lines.push("## Repos needing update\n");

    for (const result of needsUpdate.sort((a, b) =>
      a.repoName.localeCompare(b.repoName),
    )) {
      lines.push(`### ${result.repoName}\n`);
      lines.push("| File | Current version |");
      lines.push("|------|----------------|");

      for (const location of result.locations) {
        lines.push(`| \`${location.filePath}\` | ${location.currentVersion} |`);
      }

      lines.push("");
    }
  }

  if (upToDate.length > 0) {
    lines.push("## Up to date\n");
    for (const result of upToDate.sort((a, b) =>
      a.repoName.localeCompare(b.repoName),
    )) {
      lines.push(`- ${result.repoName}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function fixReport(title: string, results: FixResult[]): string {
  const lines: string[] = [header(title)];

  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  lines.push(
    `**${succeeded.length}** fixed, **${failed.length}** need manual attention.\n\n`,
  );

  if (succeeded.length > 0) {
    lines.push("## Fixed\n");
    lines.push("| Repo | Strategy | Changes | PR |");
    lines.push("|------|----------|---------|-----|");

    for (const result of succeeded) {
      const changes = result.changesMade.join(", ") || "—";
      const pr = result.prUrl ? `[PR](${result.prUrl})` : "Not yet created";
      lines.push(
        `| ${result.repoName} | ${result.strategy} | ${changes} | ${pr} |`,
      );
    }
    lines.push("");
  }

  if (failed.length > 0) {
    lines.push("## Needs manual attention\n");

    for (const result of failed) {
      lines.push(`### ${result.repoName}\n`);
      lines.push(`**Reason:** ${result.errorMessage}\n`);
    }
  }

  return lines.join("\n");
}
