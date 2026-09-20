import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findNpmCli } from "../../scripts/find-npm-cli.mjs";

// Resolves from <compile-root>/tests/ to the repository root, whether the test
// runs from dist/tests or .test-dist/tests.
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

interface PackEntry {
  path: string;
  size: number;
}

interface PackResult {
  files: PackEntry[];
  entryCount?: number;
}

async function packDryRun(): Promise<PackResult> {
  const child = spawn(process.execPath, [
    findNpmCli(),
    "pack",
    "--dry-run",
    "--json",
  ], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (exitCode) => resolve(exitCode));
  });
  assert.equal(code, 0, `npm pack --dry-run --json failed (exit ${code}): ${stderr.slice(0, 2000)}`);
  const parsed = JSON.parse(stdout) as PackResult[];
  assert.ok(Array.isArray(parsed) && parsed.length > 0, "npm pack did not report package metadata");
  return parsed[0] as PackResult;
}

test("packed tarball ships only the production build", async () => {
  const packed = await packDryRun();
  const paths = packed.files.map((entry) => entry.path);

  // The review measured ~743KB of test bytes inside the published package.
  // Nothing under src/tests, the test-compile output, or fixtures may leak in.
  const forbidden = paths.filter((path) =>
    /(?:^|\/)tests\//u.test(path) || path.includes(".test-dist") || /fixtures/u.test(path)
  );
  assert.deepEqual(forbidden, [], "packed tarball must not contain test artifacts");

  // The production entry points the ACP registry and the bin rely on.
  assert.ok(paths.includes("dist/index.js"), "tarball must include dist/index.js");
  assert.ok(paths.includes("dist/version.js"), "tarball must include dist/version.js");

  // Every shipped file lives under the declared `files` allowlist.
  const strays = paths.filter((path) => path !== "package.json" && !path.startsWith("dist/")
    && path !== "README.md" && path !== "LICENSE");
  assert.deepEqual(strays, [], "tarball contains files outside the dist allowlist");
});
