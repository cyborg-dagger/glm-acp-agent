import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { AGENT_NAME, AGENT_VERSION } from "../version.js";
import { HttpMcpClient, StdioMcpClient } from "../tools/session-mcp-client.js";
import { ZaiMcpClient } from "../tools/zai-mcp-client.js";
import { StdioVisionMcpClient } from "../tools/vision-mcp-client.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as { name: string; version: string };

interface ClientInfo {
  name: string;
  version: string;
}

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid: number;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
}

function makeFakeChild(): {
  child: FakeChild;
  written: string[];
  pushStdout: (line: string) => void;
} {
  const written: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk.toString("utf8"));
      cb();
    },
  });
  const stdout = new Readable({ read() { /* push manually */ } });
  const stderr = new Readable({ read() { /* push manually */ } });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 5150,
    exitCode: null,
    kill: () => {
      child.exitCode = 137;
      queueMicrotask(() => child.emit("exit", 137, "SIGTERM"));
      return true;
    },
  }) as FakeChild;
  return { child, written, pushStdout: (line) => stdout.push(line) };
}

const tick = () => new Promise((r) => setImmediate(r));

test("version identity comes from package metadata", () => {
  assert.equal(AGENT_NAME, "glm-acp-agent");
  assert.equal(AGENT_NAME, packageJson.name);
  assert.equal(AGENT_VERSION, packageJson.version);
  assert.ok(AGENT_NAME.length > 0);
  assert.ok(AGENT_VERSION.length > 0);
});

test("HTTP MCP handshake advertises the package-derived client identity", async () => {
  const originalFetch = globalThis.fetch;
  let captured: ClientInfo | undefined;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number;
      method?: string;
      params?: { clientInfo?: ClientInfo };
    };
    if (body.method === "initialize") {
      captured = body.params?.clientInfo;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
        headers: { "Content-Type": "application/json", "MCP-Session-Id": "version-session" },
      });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected method ${String(body.method)}`);
  }) as typeof fetch;
  try {
    const client = new HttpMcpClient({
      type: "http",
      name: "fixture",
      url: "https://fixture.invalid",
      headers: [],
    });
    await client.listTools();
    await client.dispose();
    assert.deepEqual(captured, { name: AGENT_NAME, version: AGENT_VERSION });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stdio MCP handshake advertises the package-derived client identity", async () => {
  const { child, written, pushStdout } = makeFakeChild();
  const client = new StdioMcpClient(
    { name: "docs", command: "npx", args: ["-y", "@example/mcp-docs"], env: [] },
    { spawn: () => child as never }
  );
  try {
    const listPromise = client.listTools();
    await tick();
    const initRequest = JSON.parse(written[0]?.trim() ?? "{}") as {
      method?: string;
      id: number;
      params?: { clientInfo?: ClientInfo };
    };
    assert.equal(initRequest.method, "initialize");
    assert.deepEqual(initRequest.params?.clientInfo, { name: AGENT_NAME, version: AGENT_VERSION });
    pushStdout(JSON.stringify({ jsonrpc: "2.0", id: initRequest.id, result: {} }) + "\n");
    await tick();
    const listRequest = JSON.parse(written[2]?.trim() ?? "{}") as { id: number };
    pushStdout(JSON.stringify({ jsonrpc: "2.0", id: listRequest.id, result: { tools: [] } }) + "\n");
    await listPromise;
  } finally {
    await client.dispose();
  }
});

test("Z.AI MCP handshake advertises the package-derived client identity", async () => {
  const calls: Array<{ body: { id?: number; method?: string; params?: { clientInfo?: ClientInfo } } }> = [];
  const jsonResponse = (body: unknown, sessionId?: string) => {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (sessionId) headers.set("MCP-Session-Id", sessionId);
    return new Response(JSON.stringify(body), { headers });
  };
  const fetchStub = async (_url: string | URL | Request, init?: RequestInit) => {
    assert.ok(init, "fetch init is required");
    const body = JSON.parse(String(init.body)) as { id?: number; method?: string; params?: { clientInfo?: ClientInfo } };
    calls.push({ body });
    if (body.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} }, "session-1");
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "webSearchPrime", inputSchema: { properties: {} } }] },
      });
    }
    if (body.method === "tools/call") {
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } });
    }
    throw new Error(`unexpected method ${String(body.method)}`);
  };

  const client = new ZaiMcpClient(fetchStub as typeof fetch);
  await client.callTool({
    endpoint: "https://api.z.ai/api/mcp/web_search_prime/mcp",
    toolName: "webSearchPrime",
    arguments: { query: "glm" },
    apiKey: "test-key",
  });
  assert.equal(calls[0]?.body.method, "initialize");
  assert.deepEqual(calls[0]?.body.params?.clientInfo, { name: AGENT_NAME, version: AGENT_VERSION });
});

test("Vision MCP handshake advertises the package-derived client identity", async () => {
  const { child, written, pushStdout } = makeFakeChild();
  const client = new StdioVisionMcpClient({ apiKey: "test-key", spawn: () => child as never });
  try {
    const callPromise = client.callTool("image_analysis", { image_source: "x" });
    await tick();
    const initRequest = JSON.parse(written[0]?.trim() ?? "{}") as {
      method?: string;
      id: number;
      params?: { clientInfo?: ClientInfo };
    };
    assert.equal(initRequest.method, "initialize");
    assert.deepEqual(initRequest.params?.clientInfo, { name: AGENT_NAME, version: AGENT_VERSION });
    pushStdout(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\n");
    await tick();
    pushStdout(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "image_analysis" }] } }) + "\n");
    await tick();
    pushStdout(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "ok" }] } }) + "\n");
    await callPromise;
    await client.dispose();
  } finally {
    await client.dispose();
  }
});

test("MCP clients no longer hardcode a fallback version identity", () => {
  const handshakeSources = [
    "session-mcp-client.ts",
    "zai-mcp-client.ts",
    "vision-mcp-client.ts",
  ].map((name) => new URL(`../../src/tools/${name}`, import.meta.url));
  for (const sourceUrl of handshakeSources) {
    const source = readFileSync(sourceUrl, "utf8");
    assert.match(source, /import \{ AGENT_NAME, AGENT_VERSION \} from "\.\.\/version\.js";/u);
    assert.doesNotMatch(source, /version:\s*"1\.0\.0"/u);
  }
});
