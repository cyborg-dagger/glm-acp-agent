import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { StdioMcpClient } from "../tools/session-mcp-client.js";
import { StdioVisionMcpClient } from "../tools/vision-mcp-client.js";

type Adapter = "session" | "vision";
const adapters: Adapter[] = ["session", "vision"];
const sessionModule = new URL("../tools/session-mcp-client.js", import.meta.url).href;
const visionModule = new URL("../tools/vision-mcp-client.js", import.meta.url).href;

// Run the host in isolation: a callback throw or an unhandled pipe error must
// fail this assertion without taking down the rest of the test runner.
function runHost(adapter: Adapter, serverScript: string, assertions: string): void {
  const host = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { spawn } from "node:child_process";
    import { once } from "node:events";
    import { StdioMcpClient } from ${JSON.stringify(sessionModule)};
    import { StdioVisionMcpClient } from ${JSON.stringify(visionModule)};
    const serverScript = ${JSON.stringify(serverScript)};
    const createClient = (spawnChild) => ${adapter === "session"
      ? `new StdioMcpClient({ name: "fixture", command: process.execPath, args: [], env: [] }, { spawn: spawnChild, initializationTimeoutMs: 1500, requestTimeoutMs: 1500 })`
      : `new StdioVisionMcpClient({ apiKey: "fixture-key", spawn: spawnChild, initializationTimeoutMs: 1500, requestTimeoutMs: 1500 })`};
    const spawnServer = (script) => spawn(process.execPath, ["-e", script], { stdio: "pipe" });
    ${assertions}
  `], { encoding: "utf8", timeout: 6_000 });
  assert.equal(host.error, undefined, String(host.error));
  assert.equal(host.status, 0, host.stderr || host.stdout);
}

function respondingServer(extraResponse = ""): string {
  return `
    const readline = require("node:readline");
    setTimeout(() => process.exit(0), 3500).unref();
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      if (request.method === "initialize") reply({});
      else if (request.method === "tools/list") reply({ tools: [{ name: "image_analysis" }] });
      else {
        ${extraResponse}
        reply({ content: [{ type: "text", text: "ok" }] });
      }
    });
  `;
}

for (const adapter of adapters) {
  for (const frame of ["null", "[]", "42", "true", '"noise"']) {
    // Removing decoded-value validation must make at least the null case crash.
    test(`${adapter} stdio ignores non-object JSON frame ${frame}`, () => {
      runHost(adapter, respondingServer(`process.stdout.write(${JSON.stringify(frame + "\n")});`), `
        const client = createClient(() => spawnServer(serverScript));
        try {
          assert.deepEqual(await client.callTool("image_analysis", {}), { content: [{ type: "text", text: "ok" }] });
        } finally { await client.dispose(); }
      `);
    });
  }

  // Invalid response fields must not consume the request before its valid reply.
  test(`${adapter} stdio ignores malformed response envelopes`, () => {
    runHost(adapter, respondingServer(`
      for (const invalid of [
        { jsonrpc: "2.0", id: request.id },
        { jsonrpc: "2.0", id: request.id, error: null },
        { jsonrpc: "2.0", id: request.id, error: [] },
        { jsonrpc: "2.0", id: request.id, error: "bad" },
        { jsonrpc: "2.0", id: request.id, error: { message: {} } },
        { jsonrpc: "2.0", id: request.id, error: { code: [] } },
        { jsonrpc: "1.0", id: request.id, result: "wrong version" },
      ]) process.stdout.write(JSON.stringify(invalid) + "\\n");
    `), `
      const client = createClient(() => spawnServer(serverScript));
      try {
        assert.deepEqual(await client.callTool("image_analysis", {}), { content: [{ type: "text", text: "ok" }] });
      } finally { await client.dispose(); }
    `);
  });

  // A synchronous write double misses the actual Socket error event (EPIPE).
  test(`${adapter} stdio contains real EPIPE and can reconnect`, () => {
    const closedStdinServer = `
      const { readSync, closeSync } = require("node:fs");
      setTimeout(() => process.exit(0), 1800);
      const buffer = Buffer.alloc(4096);
      let line = "";
      while (!line.includes("\\n")) line += buffer.subarray(0, readSync(0, buffer)).toString();
      const request = JSON.parse(line.trim());
      closeSync(0);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
    `;
    runHost(adapter, closedStdinServer, `
      let firstClosed;
      let launches = 0;
      const client = createClient(() => {
        const child = spawnServer(launches++ === 0 ? serverScript : ${JSON.stringify(respondingServer())});
        if (launches === 1) firstClosed = once(child, "close");
        return child;
      });
      try {
        const failed = await Promise.allSettled([
          client.callTool("image_analysis", {}), client.callTool("image_analysis", {}),
        ]);
        for (const result of failed) {
          assert.equal(result.status, "rejected");
          assert.match(result.reason.message, /EPIPE/);
        }
        await firstClosed;
        assert.deepEqual(await client.callTool("image_analysis", {}), { content: [{ type: "text", text: "ok" }] });
      } finally { await client.dispose(); }
    `);
  });

  // A disposed client must refuse later work rather than launching a new server.
  test(`${adapter} stdio refuses calls after disposal`, () => {
    runHost(adapter, respondingServer(), `
      const client = createClient(() => spawnServer(serverScript));
      try {
        await client.callTool("image_analysis", {});
        await client.dispose();
        await assert.rejects(client.callTool("image_analysis", {}), /client disposed/);
      } finally { await client.dispose(); }
    `);
  });
}

function makeChild(stalledMethod: string) {
  let accepted = 0;
  let resolveAccepted!: () => void;
  const requestsAccepted = new Promise<void>((resolve) => { resolveAccepted = resolve; });
  const stdout = new Readable({ read() { /* pushed by the fixture */ } });
  const stderr = new Readable({ read() { /* no fixture diagnostics */ } });
  const child = Object.assign(new EventEmitter(), {
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        const request = JSON.parse(String(chunk));
        callback();
        if (request.id === undefined) return;
        if (request.method === stalledMethod) {
          accepted += 1;
          if (accepted === (stalledMethod === "initialize" ? 1 : 2)) resolveAccepted();
          return;
        }
        const result = request.method === "tools/list" ? { tools: [{ name: "image_analysis" }] } : {};
        queueMicrotask(() => stdout.push(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n"));
      },
    }),
    stdout,
    stderr,
    pid: 4242,
    exitCode: null,
    kill: () => true, // Intentionally cannot prove exit, as in the existing disposal fixtures.
  });
  return { child, requestsAccepted };
}

function fixtureClient(adapter: Adapter, child: ReturnType<typeof makeChild>["child"], requestTimeoutMs = 3_000) {
  return adapter === "session"
    ? new StdioMcpClient({ name: "fixture", command: "node", args: [], env: [] }, {
      // Keep fake PIDs out of the real Windows process-tree terminator.
      platform: "linux", spawn: () => child as never, requestTimeoutMs, initializationTimeoutMs: 3_000,
    })
    : new StdioVisionMcpClient({ apiKey: "fixture-key", platform: "linux", spawn: () => child as never, requestTimeoutMs, initializationTimeoutMs: 3_000 });
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("request settlement deadline exceeded")), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

for (const adapter of adapters) {
  for (const stalledMethod of ["initialize", "tools/call"]) {
    // Moving settlement after termination leaves accepted calls pending on failure.
    test(`${adapter} stdio disposal settles pending ${stalledMethod} before failed termination`, async () => {
      const { child, requestsAccepted } = makeChild(stalledMethod);
      const client = fixtureClient(adapter, child);
      const controllers = [new AbortController(), new AbortController()];
      const calls = controllers.map(controller => client.callTool("image_analysis", {}, controller.signal));
      const results = Promise.allSettled(calls);
      let disposing: Promise<void> | undefined;
      try {
        await within(requestsAccepted, 1_000);
        disposing = client.dispose();
        void disposing.catch(() => {});
        for (const result of await within(results, 100)) {
          assert.equal(result.status, "rejected");
          if (result.status === "rejected") assert.match(result.reason.message, /client disposed/);
        }
        await assert.rejects(disposing, /did not exit after termination/);
        assert.equal(child.stdin.destroyed, true);
        assert.equal(child.stdout.destroyed, true);
        assert.equal(child.stderr.destroyed, true);
        await assert.rejects(client.callTool("image_analysis", {}), /client disposed/);
      } finally {
        controllers.forEach(controller => controller.abort());
        await results;
        await disposing?.catch(() => {});
      }
    });
  }
}

// Losing the connection field must not disable the request's own deadline.
test("vision stdio request deadline settles after its child field is cleared", async () => {
  const { child, requestsAccepted } = makeChild("tools/call");
  const client = fixtureClient("vision", child, 50);
  const controllers = [new AbortController(), new AbortController()];
  const calls = controllers.map(controller => client.callTool("image_analysis", {}, controller.signal));
  const results = Promise.allSettled(calls);
  try {
    await within(requestsAccepted, 1_000);
    (client as unknown as { child: unknown }).child = null;
    for (const result of await within(results, 200)) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.match(result.reason.message, /timed out after 50ms/);
    }
  } finally {
    controllers.forEach(controller => controller.abort());
    await results;
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    await client.dispose();
  }
});
