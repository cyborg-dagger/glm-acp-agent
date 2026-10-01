import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GlmAcpAgent } from "../protocol/agent.js";
import { SessionStore, type PersistedSession } from "../protocol/session-store.js";
import { SessionMcpTools } from "../tools/session-mcp-client.js";
import type { GlmStreamChunk } from "../llm/glm-client.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function connection() {
  return {
    signal: new AbortController().signal,
    async sessionUpdate() {},
    async requestPermission() { return { outcome: { outcome: "selected", optionId: "allow" } }; },
  };
}

function textGlm() {
  return { async *streamChat(): AsyncGenerator<GlmStreamChunk> {
    yield { text: "done" };
    yield { done: true, stopReason: "stop" };
  } };
}

async function withCheckpointWrites(
  dir: string,
  onWritten: (snapshot: PersistedSession, path: string) => Promise<void>,
  run: () => Promise<void>,
) {
  const originalOpen = fs.open;
  fs.open = (async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path).startsWith(`${dir}/.`)) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (data, ...writeArgs) => {
        await write(data, ...writeArgs);
        await onWritten(JSON.parse(Buffer.from(data as Uint8Array).toString("utf8")) as PersistedSession, String(path));
      };
    }
    return handle;
  }) as typeof fs.open;
  syncBuiltinESMExports();
  try { await run(); } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
}

for (const mode of ["close", "shutdown"] as const) {
  test(`a fork cancelled by ${mode} during child persistence leaves no durable child`, { timeout: 10_000 }, async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "glm-fork-rollback-"));
    const dir = join(cwd, "sessions");
    const store = new SessionStore(dir);
    const written = deferred();
    const release = deferred();
    let parentId = "";
    let childId = "";
    let tempPath = "";
    let childSignal: AbortSignal | undefined;
    let connections = 0;
    const disposals = [0, 0];
    const tools = [new SessionMcpTools([]), new SessionMcpTools([])];
    for (const [index, owned] of tools.entries()) {
      const dispose = owned.dispose.bind(owned);
      owned.dispose = async () => { disposals[index]!++; await dispose(); };
    }
    const agent = new GlmAcpAgent(connection() as never, {
      sessionStore: store, glm: textGlm(),
      connectSessionMcpServers: async (_servers, signal) => {
        if (connections === 1) childSignal = signal;
        return tools[connections++]!;
      },
    });
    let fresh: GlmAcpAgent | undefined;
    let fork: Promise<unknown> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      parentId = (await agent.newSession({ cwd, mcpServers: [] })).sessionId;
      await agent.prompt({ sessionId: parentId, prompt: [{ type: "text", text: "parent history" }] });
      await withCheckpointWrites(dir, async (snapshot, path) => {
        if (snapshot.sessionId === parentId) return;
        childId = snapshot.sessionId;
        tempPath = path;
        written.resolve();
        await release.promise;
      }, async () => {
        fork = agent.unstable_forkSession({ sessionId: parentId, cwd, mcpServers: [] });
        const rejected = assert.rejects(fork, /Session fork cancelled/);
        await written.promise;
        await fs.access(tempPath);
        await assert.rejects(fs.access(join(dir, `${childId}.json`)), { code: "ENOENT" });
        stopping = mode === "close" ? agent.closeSession({ sessionId: parentId }) : agent.shutdown("disconnect");
        assert.equal(childSignal?.aborted, true);
        release.resolve();
        await rejected;
        await stopping;
        await assert.rejects(fs.access(join(dir, `${childId}.json`)), { code: "ENOENT" });
      });
      assert.deepEqual(disposals, [1, 1]);
      assert.deepEqual((await agent.listSessions({ cwd })).sessions.map(session => session.sessionId), [parentId]);
      const freshStore = new SessionStore(dir);
      assert.equal(await freshStore.loadAsync(childId), undefined);
      fresh = new GlmAcpAgent(connection() as never, { sessionStore: freshStore, glm: textGlm() });
      await assert.rejects(fresh.resumeSession({ sessionId: childId, cwd, mcpServers: [] }), /not found/i);
      await fresh.resumeSession({ sessionId: parentId, cwd, mcpServers: [] });
      assert.ok((await freshStore.loadAsync(parentId))?.messages.some(message => message.role === "user" && message.content === "parent history"));
      const retry = await fresh.unstable_forkSession({ sessionId: parentId, cwd, mcpServers: [] });
      assert.notEqual(retry.sessionId, childId);
      assert.deepEqual(new Set((await fresh.listSessions({ cwd })).sessions.map(session => session.sessionId)), new Set([parentId, retry.sessionId]));
    } finally {
      release.resolve();
      await Promise.allSettled([fork, stopping]);
      await fresh?.shutdown("disconnect");
      await agent.shutdown("disconnect");
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
}

test("cancelled fork rollback waits for every accepted child write", { timeout: 10_000 }, async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "glm-fork-rollback-order-"));
  const dir = join(cwd, "sessions");
  const store = new SessionStore(dir);
  const firstWritten = deferred();
  const releaseFirst = deferred();
  const secondWritten = deferred();
  const releaseSecond = deferred();
  let parentId = "";
  let child: PersistedSession | undefined;
  let childWrites = 0;
  const agent = new GlmAcpAgent(connection() as never, { sessionStore: store, glm: textGlm() });
  let fork: Promise<unknown> | undefined;
  let stopping: Promise<void> | undefined;
  let queued: Promise<void> | undefined;
  try {
    parentId = (await agent.newSession({ cwd, mcpServers: [] })).sessionId;
    await withCheckpointWrites(dir, async snapshot => {
      if (snapshot.sessionId === parentId) return;
      if (++childWrites === 1) {
        child = snapshot;
        firstWritten.resolve();
        await releaseFirst.promise;
      } else {
        secondWritten.resolve();
        await releaseSecond.promise;
      }
    }, async () => {
      let forkSettled = false;
      fork = agent.unstable_forkSession({ sessionId: parentId, cwd, mcpServers: [] });
      void fork.then(() => { forkSettled = true; }, () => { forkSettled = true; });
      const rejected = assert.rejects(fork, /Session fork cancelled/);
      await firstWritten.promise;
      queued = store.save({ ...child!, title: "accepted later checkpoint" });
      stopping = agent.closeSession({ sessionId: parentId });
      releaseFirst.resolve();
      await secondWritten.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(forkSettled, false, "fork rejection waits for the queued write before removing its record");
      releaseSecond.resolve();
      await Promise.all([queued, rejected, stopping]);
      await assert.rejects(fs.access(join(dir, `${child!.sessionId}.json`)), { code: "ENOENT" });
      assert.equal(await new SessionStore(dir).loadAsync(child!.sessionId), undefined);
    });
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    await Promise.allSettled([fork, stopping, queued]);
    await agent.shutdown("disconnect");
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("cancelled fork reports a failed durable-child rollback to its caller", { timeout: 10_000 }, async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "glm-fork-rollback-error-"));
  const dir = join(cwd, "sessions");
  const store = new SessionStore(dir);
  const written = deferred();
  const release = deferred();
  let parentId = "";
  let childId = "";
  const failure = Object.assign(new Error("fixture unlink denied"), { code: "EACCES" });
  const originalUnlink = fs.unlink;
  const agent = new GlmAcpAgent(connection() as never, { sessionStore: store, glm: textGlm() });
  let fork: Promise<unknown> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    parentId = (await agent.newSession({ cwd, mcpServers: [] })).sessionId;
    fs.unlink = async path => {
      if (String(path) === join(dir, `${childId}.json`)) throw failure;
      await originalUnlink(path);
    };
    syncBuiltinESMExports();
    await withCheckpointWrites(dir, async snapshot => {
      if (snapshot.sessionId === parentId) return;
      childId = snapshot.sessionId;
      written.resolve();
      await release.promise;
    }, async () => {
      fork = agent.unstable_forkSession({ sessionId: parentId, cwd, mcpServers: [] });
      const rejected = assert.rejects(fork, error => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /rollback failed/i);
        assert.match(error.message, new RegExp(childId));
        assert.match(String(error.errors[0]), /Session fork cancelled/);
        assert.equal(error.errors[1], failure);
        return true;
      });
      await written.promise;
      stopping = agent.closeSession({ sessionId: parentId });
      release.resolve();
      await rejected;
      await stopping;
      assert.ok(await new SessionStore(dir).loadAsync(childId), "failed removal remains recoverable and its error is visible");
    });
    await assert.rejects(store.flush(), error => error instanceof AggregateError && error.errors.includes(failure));
  } finally {
    release.resolve();
    await Promise.allSettled([fork, stopping]);
    fs.unlink = originalUnlink;
    syncBuiltinESMExports();
    await store.flush().catch(() => undefined);
    await agent.shutdown("disconnect");
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

for (const mode of ["restore", "fork"]) {
  test(`a zero-timeout ${mode} assigns its required deferred checkpoint failure to the prompt`, { timeout: 10_000 }, async () => {
    const fixture = fileURLToPath(new URL("./fixtures/deferred-checkpoint.js", import.meta.url));
    const result = await promisify(execFile)(process.execPath, ["--unhandled-rejections=strict", fixture, mode], { timeout: 8_000 });
    assert.match(result.stdout, /checkpoint error reached prompt; transition released; no unhandled rejection/);
  });
}

test("successful removal retains an earlier accepted write failure for flush", async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "glm-remove-save-failure-"));
  const dir = join(cwd, "sessions");
  const store = new SessionStore(dir);
  const session: PersistedSession = {
    sessionId: "provisional-child", cwd, messages: [], title: null,
    updatedAt: "2026-10-01T10:00:00.000Z", model: "glm-5.3", mode: "default",
  };
  try {
    const target = join(dir, `${session.sessionId}.json`);
    await fs.mkdir(target, { recursive: true });
    let writeFailure: unknown;
    await assert.rejects(store.save(session), error => { writeFailure = error; return true; });
    await fs.rm(target, { recursive: true });
    await store.save(session);
    await store.remove(session.sessionId);
    assert.equal(await store.loadAsync(session.sessionId), undefined);
    await assert.rejects(store.flush(), error => error instanceof AggregateError && error.errors.includes(writeFailure));
    await store.flush();
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("loads and flush observe an accepted removal after its preceding checkpoint", async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "glm-remove-read-order-"));
  const store = new SessionStore(join(cwd, "sessions"));
  const session: PersistedSession = {
    sessionId: "provisional-child", cwd, messages: [], title: null,
    updatedAt: "2026-10-01T10:00:00.000Z", model: "glm-5.3", mode: "default",
  };
  try {
    const saving = store.save(session);
    const removing = store.remove(session.sessionId);
    assert.equal(await store.loadAsync(session.sessionId), undefined);
    await store.flush();
    await Promise.all([saving, removing]);
    await assert.rejects(fs.access(join(cwd, "sessions", `${session.sessionId}.json`)), { code: "ENOENT" });
    await store.remove(session.sessionId); // An already absent provisional child is safe to remove.
    await store.save({ ...session, title: "explicit later write" });
    assert.equal((await store.loadAsync(session.sessionId))?.title, "explicit later write");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
