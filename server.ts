/**
 * Repokeeper MCP Server
 *
 * Registers each tool so that GitHub Copilot CLI can call them.
 * Runs on stdio — Copilot starts it as a subprocess.
 *
 * Each tool:
 *   1. Receives parameters from Copilot
 *   2. Runs the corresponding scan/fix function
 *   3. Returns a markdown report
 *
 * To add a new tool: define it with server.tool() and call
 * the appropriate function from tools/. That's it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { scanAllRepos as scanVulns } from "./tools/scan-vulnerabilities.js";
import { scanAllRepos as scanSpecificVuln } from "./tools/scan-specific-vulnerability.js";
import { fixRepos as fixVulns } from "./tools/fix-vulnerabilities.js";
import { scanAllRepos as scanNode } from "./tools/scan-node-versions.js";
import { fixRepos as fixNode } from "./tools/fix-node-versions.js";

const server = new McpServer({
  name: "repokeeper",
  version: "1.0.0",
});

// ─── Tool 1: Scan vulnerabilities ────────────────────────────

server.tool(
  "scan_vulnerabilities",
  "Scan all repos for moderate-to-critical vulnerability alerts. " +
    "Returns a markdown report showing each vulnerability, its severity, " +
    "which package is affected, and which direct dependency pulls it in.",
  {},
  async () => {
    const report = await scanVulns();
    return { content: [{ type: "text" as const, text: report }] };
  },
);

// ─── Tool 2: Scan for a specific vulnerability ───────────────

server.tool(
  "scan_specific_vulnerability",
  "Scan all repos to check if a specific package at a specific version " +
    "exists anywhere in their dependency tree. " +
    "Returns which repos contain it and which direct dependency pulls it in.",
  {
    package_name: z.string().describe("The npm package name (e.g. 'lodash')"),
    version: z.string().describe("The exact version to search for (e.g. '4.17.20')"),
  },
  async ({ package_name, version }) => {
    const report = await scanSpecificVuln(package_name, version);
    return { content: [{ type: "text" as const, text: report }] };
  },
);

// ─── Tool 3: Fix vulnerabilities ─────────────────────────────

server.tool(
  "fix_vulnerabilities",
  "Fix vulnerability alerts in the specified repos. " +
    "Tries three strategies: update the direct dependency, add an override, " +
    "or flag for manual attention. Creates a branch for each repo. " +
    "Set create_prs to true to also open pull requests.",
  {
    repo_names: z
      .array(z.string())
      .describe("List of repo names to fix"),
    create_prs: z
      .boolean()
      .default(false)
      .describe("Whether to create PRs after fixing"),
  },
  async ({ repo_names, create_prs }) => {
    const report = await fixVulns(repo_names, create_prs);
    return { content: [{ type: "text" as const, text: report }] };
  },
);

// ─── Tool 4: Scan Node versions ──────────────────────────────

server.tool(
  "scan_node_versions",
  "Scan all repos to find every place a Node version is referenced " +
    "and check whether it matches the target version. " +
    "Checks .nvmrc, package.json engines, CDK Runtime, GitHub Actions, " +
    "Dockerfile, and buildspec.yml.",
  {},
  async () => {
    const report = await scanNode();
    return { content: [{ type: "text" as const, text: report }] };
  },
);

// ─── Tool 5: Fix Node versions ───────────────────────────────

server.tool(
  "fix_node_versions",
  "Upgrade Node version references in the specified repos. " +
    "Updates .nvmrc, package.json, CDK files, workflows, Dockerfile, buildspec. " +
    "Runs npm install to verify. Creates a branch for each repo. " +
    "Set create_prs to true to also open pull requests.",
  {
    repo_names: z
      .array(z.string())
      .describe("List of repo names to fix"),
    create_prs: z
      .boolean()
      .default(false)
      .describe("Whether to create PRs after fixing"),
  },
  async ({ repo_names, create_prs }) => {
    const report = await fixNode(repo_names, create_prs);
    return { content: [{ type: "text" as const, text: report }] };
  },
);

// ─── Start ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
