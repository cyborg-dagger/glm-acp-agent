import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const packageRoot = process.cwd();
const smokeDirectory = await mkdtemp(join(tmpdir(), "glm-acp-package-smoke-"));

function findNpmCli() {
  const candidates = [
    process.env["npm_execpath"],
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string");
  const npmCli = candidates.find((candidate) => existsSync(candidate));
  if (!npmCli) throw new Error("Could not locate npm-cli.js for the packed package smoke test");
  return npmCli;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "inherit"],
      ...options,
    });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stdout }));
  });
}

try {
  const npmCli = findNpmCli();
  const npmArgs = (args) => [npmCli, ...args];
  const pack = await run(process.execPath, npmArgs(["pack", "--pack-destination", smokeDirectory, "--json"]));
  if (pack.signal !== null || pack.code !== 0) {
    throw new Error(`npm pack failed with exit code ${pack.code ?? "unknown"}`);
  }
  const metadata = JSON.parse(pack.stdout);
  const filename = metadata[0]?.filename;
  if (typeof filename !== "string") {
    throw new Error("npm pack did not report a tarball filename");
  }

  const tarball = join(smokeDirectory, filename);
  const smoke = await run(
    process.execPath,
    npmArgs(["exec", "--yes", `--package=${tarball}`, "--", "glm-acp-agent", "--help"]),
    {
      cwd: smokeDirectory,
      env: { ...process.env, Z_AI_API_KEY: "" },
    }
  );
  if (smoke.signal !== null || smoke.code !== 0) {
    throw new Error(`packed CLI help failed with exit code ${smoke.code ?? "unknown"}`);
  }
  if (!smoke.stdout.includes("glm-acp-agent") || !smoke.stdout.includes("Usage:")) {
    throw new Error("packed CLI help output was missing the command name or usage text");
  }
} finally {
  await rm(smokeDirectory, { recursive: true, force: true });
}
