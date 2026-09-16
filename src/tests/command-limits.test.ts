import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../tools/executor.js";
import {
  DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES,
  DEFAULT_COMMAND_TIMEOUT_MS,
  readCommandLimits,
} from "../tools/command-limits.js";

function createConnectionStub() {
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    async sessionUpdate(payload: Record<string, unknown>) {
      updates.push(payload);
    },
  };
}

function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    old.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of old) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function commandExecutor(
  connection: ReturnType<typeof createConnectionStub>,
  cwd = process.cwd(),
  signal?: AbortSignal
) {
  return new ToolExecutor(
    connection as never,
    "s1",
    { fs: {} },
    signal,
    null,
    null,
    cwd,
    () => "bypass_permissions"
  );
}

function lastUpdate(connection: ReturnType<typeof createConnectionStub>) {
  return connection.updates.at(-1)?.update as {
    status?: string;
    rawOutput?: Record<string, unknown>;
  };
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return existsSync(path);
}

test("command limits use the documented defaults when env is absent", () => {
  const warnings: string[] = [];
  const limits = readCommandLimits({}, (message) => warnings.push(message));
  assert.deepEqual(limits, {
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    outputLimitBytes: DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES,
  });
  assert.deepEqual(warnings, []);
});

test("command limits accept positive integer env overrides", () => {
  const limits = readCommandLimits(
    {
      ACP_GLM_COMMAND_TIMEOUT_MS: "2500",
      ACP_GLM_COMMAND_OUTPUT_LIMIT_BYTES: "123",
    },
    () => undefined
  );
  assert.deepEqual(limits, { timeoutMs: 2500, outputLimitBytes: 123 });
});

test("invalid and unsafe command limits fall back with warnings", () => {
  const warnings: string[] = [];
  const limits = readCommandLimits(
    {
      ACP_GLM_COMMAND_TIMEOUT_MS: "2147483648",
      ACP_GLM_COMMAND_OUTPUT_LIMIT_BYTES: "9007199254740992",
    },
    (message) => warnings.push(message)
  );
  assert.deepEqual(limits, {
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    outputLimitBytes: DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES,
  });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? "", /ACP_GLM_COMMAND_TIMEOUT_MS/);
  assert.match(warnings[1] ?? "", /ACP_GLM_COMMAND_OUTPUT_LIMIT_BYTES/);
});

test("finite command output is capped across stdout and stderr with a truncation notice", async () => {
  const connection = createConnectionStub();
  const cwd = mkdtempSync(join(tmpdir(), "glm-command-limits-output-"));
  try {
    const result = await withEnv(
      {
        ACP_GLM_COMMAND_TIMEOUT_MS: "1000",
        ACP_GLM_COMMAND_OUTPUT_LIMIT_BYTES: "10",
      },
      () =>
        commandExecutor(connection, cwd).execute(
          "tc1",
          "run_command",
          JSON.stringify({ command: "printf 12345678; printf abcdefgh >&2" })
        )
    );
    assert.match(result.content, /Output truncated: command output exceeded 10 bytes/);
    const update = lastUpdate(connection);
    assert.equal(update.status, "completed");
    const raw = update.rawOutput ?? {};
    const capturedBytes =
      Buffer.byteLength(String(raw.stdout ?? ""), "utf8") +
      Buffer.byteLength(String(raw.stderr ?? ""), "utf8");
    assert.ok(capturedBytes <= 10, `captured ${capturedBytes} bytes`);
    assert.equal(raw.outputTruncated, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a byte cap never exposes a partial UTF-8 code point", async () => {
  const connection = createConnectionStub();
  const cwd = mkdtempSync(join(tmpdir(), "glm-command-limits-utf8-"));
  try {
    await withEnv(
      {
        ACP_GLM_COMMAND_TIMEOUT_MS: "1000",
        ACP_GLM_COMMAND_OUTPUT_LIMIT_BYTES: "1",
      },
      () =>
        commandExecutor(connection, cwd).execute(
          "tc1",
          "run_command",
          JSON.stringify({ command: "printf '\\303\\251'" })
        )
    );
    const raw = lastUpdate(connection).rawOutput ?? {};
    assert.ok(Buffer.byteLength(String(raw.stdout ?? ""), "utf8") <= 1);
    assert.equal(raw.stdout, "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a command timeout terminates the process tree and marks the tool failed", async () => {
  const connection = createConnectionStub();
  const cwd = mkdtempSync(join(tmpdir(), "glm-command-limits-timeout-"));
  const ready = join(cwd, "ready");
  const marker = join(cwd, "late");
  writeFileSync(
    join(cwd, "timeout-fixture.cjs"),
    'const fs = require("node:fs");\n' +
      'fs.writeFileSync("ready", "ready");\n' +
      'setInterval(() => process.stdout.write("x"), 1);\n' +
      'setTimeout(() => fs.writeFileSync("late", "late"), 700);\n',
    "utf8"
  );
  try {
    const started = Date.now();
    const result = await withEnv(
      {
        ACP_GLM_COMMAND_TIMEOUT_MS: "250",
        ACP_GLM_COMMAND_OUTPUT_LIMIT_BYTES: "1024",
      },
      () =>
        commandExecutor(connection, cwd).execute(
          "tc1",
          "run_command",
          JSON.stringify({
            command: "node timeout-fixture.cjs",
          })
        )
    );
    assert.ok(Date.now() - started < 2_000);
    assert.match(result.content, /timed out after 250 ms/i);
    assert.equal(lastUpdate(connection).status, "failed");
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(existsSync(ready), true);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a normal background shell exit survives a longer deadline", async () => {
  const connection = createConnectionStub();
  const cwd = mkdtempSync(join(tmpdir(), "glm-command-limits-background-deadline-"));
  const marker = join(cwd, "background-finished");
  writeFileSync(
    join(cwd, "background-fixture.cjs"),
    'setTimeout(() => require("node:fs").writeFileSync("background-finished", "done"), 1100);\n',
    "utf8"
  );
  try {
    const result = await withEnv(
      {
        ACP_GLM_COMMAND_TIMEOUT_MS: "1000",
        ACP_GLM_COMMAND_OUTPUT_LIMIT_BYTES: "1024",
      },
      () =>
        commandExecutor(connection, cwd).execute(
          "tc1",
          "run_command",
          JSON.stringify({
            command: "node background-fixture.cjs & echo started",
          })
        )
    );
    assert.match(result.content, /Exit code: 0/);
    assert.equal(await waitForFile(marker, 2_500), true);
    assert.equal(lastUpdate(connection).status, "completed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("shell-exit cleanup prevents a deadline from killing inherited pipes", async () => {
  const connection = createConnectionStub();
  const cwd = mkdtempSync(join(tmpdir(), "glm-command-limits-background-race-"));
  const ready = join(cwd, "ready");
  const release = join(cwd, "release");
  const shellExited = join(cwd, "shell-exited");
  const marker = join(cwd, "background-finished");
  writeFileSync(
    join(cwd, "foreground-fixture.cjs"),
    'const fs = require("node:fs");\n' +
      'fs.writeFileSync("ready", "ready");\n' +
      'const wait = setInterval(() => {\n' +
      '  if (fs.existsSync("release")) { clearInterval(wait); process.exit(0); }\n' +
      '}, 1);\n',
    "utf8"
  );
  writeFileSync(
    join(cwd, "background-race-fixture.cjs"),
    'setTimeout(() => require("node:fs").writeFileSync("background-finished", "done"), 1500);\n',
    "utf8"
  );
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = withEnv(
      {
        ACP_GLM_COMMAND_TIMEOUT_MS: "1000",
        ACP_GLM_COMMAND_OUTPUT_LIMIT_BYTES: "1024",
      },
      () =>
        commandExecutor(connection, cwd).execute(
          "tc1",
          "run_command",
          JSON.stringify({
            command: "trap \"echo shell-exited > shell-exited\" EXIT; node foreground-fixture.cjs; node background-race-fixture.cjs & echo started",
          })
        )
    );

    assert.equal(await waitForFile(ready, 2_000), true);
    mock.timers.tick(950);
    writeFileSync(release, "release");
    assert.equal(await waitForFile(shellExited, 2_000), true);
    // Let the real child exit event schedule its inherited-pipe drain timer.
    for (let index = 0; index < 1_000; index++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    mock.timers.tick(100);
    const result = await pending;
    assert.match(result.content, /Exit code: 0/);
    assert.doesNotMatch(result.content, /timed out/i);
    mock.timers.reset();
    assert.equal(await waitForFile(marker, 2_500), true);
    assert.equal(lastUpdate(connection).status, "completed");
  } finally {
    mock.timers.reset();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a pre-aborted command is rejected without spawning work", async () => {
  const connection = createConnectionStub();
  const controller = new AbortController();
  controller.abort();
  const result = await commandExecutor(connection, process.cwd(), controller.signal).execute(
    "tc1",
    "run_command",
    JSON.stringify({ command: "printf should-not-run" })
  );
  assert.match(result.content, /cancelled by (turn|user)|aborted/i);
  assert.equal(lastUpdate(connection).status, "failed");
});
