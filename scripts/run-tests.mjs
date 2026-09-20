import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// Optional argv[2]: the compiled tests directory, relative to the repository
// root. Defaults to the legacy production build output for backwards
// compatibility (`node scripts/run-tests.mjs` still runs dist/tests).
const testsDirectory = join(repositoryRoot, process.argv[2] ?? join("dist", "tests"));
const entries = await readdir(testsDirectory, { withFileTypes: true });
const testFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => join(testsDirectory, entry.name))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No compiled test files found in ${testsDirectory}`);
}

const child = spawn(process.execPath, ["--test", ...testFiles], {
  cwd: repositoryRoot,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    console.error(`Test runner terminated by ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
