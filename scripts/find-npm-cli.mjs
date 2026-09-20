/**
 * Locates npm's programmatic CLI entry (npm-cli.js) so scripts and tests can
 * invoke npm as `node <npm-cli.js> ...` — portable across platforms, where
 * spawning the `npm` shell shim directly is not.
 *
 * Candidates, in order:
 *   1. `npm_execpath` — set whenever this process was started by npm itself.
 *   2. The `npm` shim found on PATH, resolved through its realpath (handles
 *      symlinked installs such as Homebrew, where npm does not live relative
 *      to the node binary).
 *   3. The conventional install layouts relative to the node executable.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

function npmCliCandidates() {
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const pathDirs = (process.env["PATH"] ?? "").split(pathSeparator).filter(Boolean);
  const fromPath = pathDirs
    .map((dir) => {
      const shim = join(dir, process.platform === "win32" ? "npm.cmd" : "npm");
      try {
        if (!existsSync(shim)) return undefined;
        const real = realpathSync(shim);
        return join(dirname(real), "npm-cli.js");
      } catch {
        return undefined;
      }
    })
    .filter((candidate) => typeof candidate === "string");

  return [
    process.env["npm_execpath"],
    ...fromPath,
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string");
}

/** Returns the first npm-cli.js path that exists on disk, or throws. */
export function findNpmCli() {
  const npmCli = npmCliCandidates().find((candidate) => existsSync(candidate));
  if (!npmCli) {
    throw new Error("Could not locate npm-cli.js — set npm_execpath or install npm alongside node");
  }
  return npmCli;
}
