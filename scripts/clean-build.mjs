#!/usr/bin/env node
/**
 * Removes the fixed generated build directories under the repository root.
 *
 * Safety: the only accepted targets are the literal names "dist" and
 * ".test-dist". Arguments are treated as names, never as filesystem paths,
 * so this script can never be pointed at an arbitrary removal target.
 *
 * Usage: node scripts/clean-build.mjs [dist] [.test-dist]
 * With no arguments, removes both known directories.
 */
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const allowedTargets = new Set(["dist", ".test-dist"]);

const requested = process.argv.slice(2);
const invalid = requested.filter((name) => !allowedTargets.has(name));
if (invalid.length > 0) {
  console.error(
    `clean-build.mjs only accepts the literal targets "dist" and/or ".test-dist", got: ${invalid.join(", ")}`
  );
  process.exit(1);
}

const targets = requested.length > 0 ? requested : [...allowedTargets];

for (const name of targets) {
  const absolute = resolve(join(repositoryRoot, name));
  // Defense in depth: the resolved path must live directly under the repo root.
  if (dirname(absolute) !== repositoryRoot) {
    console.error(`Refusing to remove ${name}: it does not resolve under the repository root.`);
    process.exit(1);
  }
  await rm(absolute, { recursive: true, force: true });
}
