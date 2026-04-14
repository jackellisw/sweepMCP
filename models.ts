/**
 * Data models used across all repokeeper tools.
 *
 * All structured data flows through these interfaces.
 * No raw untyped objects passed between functions.
 */

export interface Repo {
  name: string;
  org: string;
  type: "bot" | "service" | "library" | "infrastructure";
  defaultBranch: string;
}

export type Severity = "low" | "moderate" | "high" | "critical";

export type ScanStatus = "pass" | "fail" | "warn" | "skip" | "error";

export type FixStrategy = "update_direct_dependency" | "add_override" | "manual_required";

export interface VulnerabilityResult {
  repoName: string;
  packageName: string;
  currentVersion: string;
  severity: Severity;
  patchedVersion: string;
  cveId: string;
  directDependency: string;
  detail: string;
}

export interface NodeVersionLocation {
  filePath: string;
  currentVersion: string;
  lineContent: string;
}

export interface NodeScanResult {
  repoName: string;
  locations: NodeVersionLocation[];
  needsUpdate: boolean;
}

export interface FixResult {
  repoName: string;
  branchName: string;
  success: boolean;
  strategy: FixStrategy;
  changesMade: string[];
  errorMessage: string;
  prUrl: string;
}

export interface Policy {
  targetNodeVersion: string;
  maxVulnerabilitySeverity: Severity;
  bannedPackages: Array<{ package: string; reason: string }>;
  requiredDependencyVersions: Record<string, string>;
}
