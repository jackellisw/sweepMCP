/**
 * Configuration loader for repokeeper.
 *
 * Loads the repo inventory and fleet policy from YAML files.
 * All config files live in the config/ directory.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Policy, Repo, Severity } from "./models.js";

const CONFIG_DIR = path.resolve(import.meta.dirname, "../../config");

interface RawRepoEntry {
  name: string;
  org: string;
  type: "bot" | "service" | "library" | "infrastructure";
  default_branch?: string;
}

interface RawReposFile {
  repos: RawRepoEntry[];
}

interface RawPolicyFile {
  node?: { target_version?: string };
  vulnerabilities?: { max_allowed_severity?: string };
  dependencies?: {
    banned?: Array<{ package: string; reason: string }>;
    required_minimums?: Record<string, string>;
  };
}

/**
 * Load the repo inventory from repos.yaml.
 */
export function loadRepos(configPath?: string): Repo[] {
  const filePath = configPath ?? path.join(CONFIG_DIR, "repos.yaml");
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = parseYaml(raw) as RawReposFile;

  return data.repos.map((entry) => ({
    name: entry.name,
    org: entry.org,
    type: entry.type,
    defaultBranch: entry.default_branch ?? "main",
  }));
}

/**
 * Load only repos of a specific type.
 */
export function loadReposByType(
  repoType: Repo["type"],
  configPath?: string,
): Repo[] {
  const allRepos = loadRepos(configPath);
  return allRepos.filter((repo) => repo.type === repoType);
}

/**
 * Load the fleet policy from policy.yaml.
 */
export function loadPolicy(configPath?: string): Policy {
  const filePath = configPath ?? path.join(CONFIG_DIR, "policy.yaml");
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = parseYaml(raw) as RawPolicyFile;

  return {
    targetNodeVersion: data.node?.target_version ?? "20",
    maxVulnerabilitySeverity:
      (data.vulnerabilities?.max_allowed_severity as Severity) ?? "moderate",
    bannedPackages: data.dependencies?.banned ?? [],
    requiredDependencyVersions: data.dependencies?.required_minimums ?? {},
  };
}
