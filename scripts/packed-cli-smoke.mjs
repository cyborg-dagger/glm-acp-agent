#!/usr/bin/env node
/**
 * Smoke test for the packed npm package.
 *
 * Without arguments: packs the working tree and tests that tarball (CI local
 * pack path). With an argument: tests THAT exact tarball file without
 * repacking — the release workflow uses this so the published artifact is
 * byte-for-byte the artifact that was verified.
 *
 * Coverage:
 *   1. CLI help smoke: the packed binary starts and prints usage.
 *   2. ACP smoke: drive the packed agent over stdio with a FAKE API key —
 *      initialize, session/new, and one prompt aimed at a loopback HTTP stub
 *      (never the real provider). Asserts the reported agent identity, that
 *      stdout is valid NDJSON throughout, that the failed prompt surfaces as a
 *      clean error instead of a crash, and that shutdown on EOF is clean.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { findNpmCli } from "./find-npm-cli.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const providedTarball = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (providedTarball && !existsSync(providedTarball)) {
  console.error(`packed-cli-smoke: tarball not found: ${providedTarball}`);
  process.exit(1);
}
const ownsTarball = !providedTarball;
const smokeDirectory = await mkdtemp(join(tmpdir(), "glm-acp-package-smoke-"));

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
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

/** Loopback HTTP stub that rejects every request with 401 — never a real provider. */
async function startAuthStub() {
  const requests = [];
  const server = createServer((_req, res) => {
    requests.push(_req.url);
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid api key (smoke stub)" } }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requestCount: () => requests.length,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

/**
 * Drives the packed agent over stdio through initialize + session/new + one
 * prompt that must fail cleanly against the loopback auth stub.
 */
async function acpSmoke(npmCli, tarball, workingDirectory) {
  const stub = await startAuthStub();
  const child = spawn(
    process.execPath,
    [npmCli, "exec", "--yes", `--package=${tarball}`, "--", "glm-acp-agent"],
    {
      cwd: workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        Z_AI_API_KEY: "smoke-fake-key-not-a-real-credential",
        ACP_GLM_BASE_URL: stub.url,
        ACP_GLM_SESSION_DIR: join(workingDirectory, "sessions"),
        XDG_CONFIG_HOME: join(workingDirectory, "config"),
      },
    }
  );

  const messages = [];
  const rawLines = [];
  let protocolViolation = null;
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    rawLines.push(trimmed);
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      protocolViolation ??= `stdout line is not valid NDJSON: ${trimmed.slice(0, 200)}`;
    }
  });
  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-8192);
  });

  child.stdin.on("error", () => { /* EOF/close races surface via the exit check */ });
  const send = (payload) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };
  const waitForResponse = (id, label, timeoutMs = 60_000) => {
    return new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        rejectWait(new Error(
          `timed out after ${timeoutMs}ms waiting for ${label}. `
          + `Received ${messages.length} NDJSON messages. stderr tail: ${stderrTail.slice(-2000)}`
        ));
      }, timeoutMs);
      const seen = () => messages.find((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
      const poll = setInterval(() => {
        const found = seen();
        if (found) {
          clearTimeout(timer);
          clearInterval(poll);
          resolveWait(found);
        }
      }, 25);
      timer.unref?.();
      poll.unref?.();
    });
  };

  const exit = new Promise((resolveExit) => child.on("exit", (code, signal) => resolveExit({ code, signal })));
  let exitOutcome = null;
  const exitWatchdog = setTimeout(async () => {
    if (!exitOutcome) child.kill("SIGKILL");
  }, 120_000);
  exitWatchdog.unref?.();

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    const initResponse = await waitForResponse(1, "initialize response");
    const agentInfo = initResponse.result?.agentInfo;
    if (typeof agentInfo?.name !== "string" || agentInfo.name !== packageJson.name) {
      throw new Error(`ACP initialize reported unexpected agent name: ${JSON.stringify(agentInfo)}`);
    }
    if (typeof agentInfo?.version !== "string" || agentInfo.version !== packageJson.version) {
      throw new Error(`ACP initialize reported a version that differs from package.json: ${JSON.stringify(agentInfo)}`);
    }

    send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: workingDirectory, mcpServers: [] },
    });
    const sessionResponse = await waitForResponse(2, "session/new response");
    const sessionId = sessionResponse.result?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error(`session/new did not return a sessionId: ${JSON.stringify(sessionResponse).slice(0, 300)}`);
    }

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "hello from the packed smoke test" }],
      },
    });
    const promptResponse = await waitForResponse(3, "session/prompt response");
    const failedCleanly = Boolean(promptResponse.error)
      || (promptResponse.result?.stopReason !== undefined && promptResponse.result.stopReason !== "end_turn");
    if (!failedCleanly) {
      throw new Error(
        `prompt with a fake API key did not fail cleanly: ${JSON.stringify(promptResponse).slice(0, 300)}`
      );
    }
    if (stub.requestCount() === 0) {
      throw new Error("the agent never contacted the loopback provider stub");
    }

    child.stdin.end();
    exitOutcome = await exit;
    if (exitOutcome.signal !== null || exitOutcome.code !== 0) {
      throw new Error(
        `packed agent did not shut down cleanly on EOF (exit ${exitOutcome.code ?? "unknown"}, `
        + `signal ${exitOutcome.signal ?? "none"}). stderr tail: ${stderrTail.slice(-2000)}`
      );
    }
    if (protocolViolation) throw new Error(protocolViolation);
    if (messages.length < 3) {
      throw new Error(`expected at least the three JSON-RPC responses on stdout, got ${messages.length}`);
    }
  } finally {
    clearTimeout(exitWatchdog);
    if (!exitOutcome) child.kill("SIGKILL");
    rl.close();
    await stub.close();
  }
}

try {
  const npmCli = findNpmCli();
  const npmArgs = (args) => [npmCli, ...args];

  let tarball = providedTarball;
  if (ownsTarball) {
    const pack = await run(process.execPath, npmArgs(["pack", "--pack-destination", smokeDirectory, "--json"]));
    if (pack.signal !== null || pack.code !== 0) {
      throw new Error(`npm pack failed with exit code ${pack.code ?? "unknown"}`);
    }
    const metadata = JSON.parse(pack.stdout);
    const filename = metadata[0]?.filename;
    if (typeof filename !== "string") {
      throw new Error("npm pack did not report a tarball filename");
    }
    tarball = join(smokeDirectory, filename);
  }
  console.log(`packed-cli-smoke: testing ${tarball}`);

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

  await acpSmoke(npmCli, tarball, smokeDirectory);
  console.log("packed-cli-smoke: ACP initialize + session/new + prompt smoke passed");
} finally {
  await rm(smokeDirectory, { recursive: true, force: true });
}
