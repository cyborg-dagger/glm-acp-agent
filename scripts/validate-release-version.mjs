#!/usr/bin/env node
/**
 * Validates that a release tag, package.json, and the registry manifest agree.
 *
 * Usage: node scripts/validate-release-version.mjs <tag-name>
 *
 * The tag may carry a leading "v" (the repo convention, written by `npm
 * version`). Checks:
 *   - tag version === package.json version
 *   - registry/glm-acp-agent/agent.json version === package.json version
 *   - registry distribution.npx.package pin === <name>@<version>
 *
 * Exits nonzero with a human-readable list of every disagreement.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const tag = process.argv[2];
if (typeof tag !== "string" || tag.length === 0) {
  console.error("Usage: node scripts/validate-release-version.mjs <tag-name>");
  process.exit(1);
}

const tagVersion = tag.startsWith("v") ? tag.slice(1) : tag;
if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(tagVersion)) {
  console.error(`Tag "${tag}" does not look like a semver release tag (expected vX.Y.Z).`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const manifestPath = join(repositoryRoot, "registry", "glm-acp-agent", "agent.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const checks = [
  {
    label: "package.json version",
    actual: pkg.version,
    expected: tagVersion,
  },
  {
    label: "registry manifest version",
    actual: manifest.version,
    expected: pkg.version,
  },
  {
    label: "registry npx pin",
    actual: manifest.distribution?.npx?.package,
    expected: `${pkg.name}@${pkg.version}`,
  },
];

const mismatches = checks.filter((check) => check.actual !== check.expected);
if (mismatches.length === 0) {
  console.log(
    `Release ${tag} is consistent: package.json, registry manifest, and npx pin all at ${tagVersion}.`
  );
  process.exit(0);
}

console.error(`Release tag ${tag} does not match the checkout:`);
for (const check of mismatches) {
  console.error(`  ${check.label}: ${String(check.actual)} (expected ${check.expected})`);
}
process.exit(1);
