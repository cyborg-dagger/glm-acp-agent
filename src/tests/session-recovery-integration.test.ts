import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { GlmAcpAgent } from "../protocol/agent.js";
import type { GlmMessage, GlmStreamChunk } from "../llm/glm-client.js";
import { SessionStore, SESSION_SCHEMA_VERSION } from "../protocol/session-store.js";
import type { PersistedSession } from "../protocol/session-store.js";
import {
  CheckpointError,
  INTERRUPTION_NOTE,
  UNKNOWN_OUTCOME_TEXT,
} from "../protocol/session-recovery.js";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

// Defence in depth: these tests use explicit temp stores, but redirect the
// on-disk default path and HOME to isolated tempdirs so nothing can leak into
// the developer's home directory.
process.env["ACP_GLM_SESSION_DIR"] = mkdtempSync(
  pathJoin(osTmpdir(), "glm-acp-test-recovery-default-")
);
const isolatedHome = mkdtempSync(pathJoin(osTmpdir(), "glm-acp-test-recovery-home-"));
process.env["HOME"] = isolatedHome;
process.env["USERPROFILE"] = isolatedHome;

// ---------------------------------------------------------------------------
// Test helpers (mirroring the idioms in agent.test.ts)
// ---------------------------------------------------------------------------

interface ConnectionStub {
  updates: Array<Record<string, unknown>>;
  sessionUpdate(params: Record<string, unknown>): Promise<void>;
}

function createConnectionStub(): ConnectionStub {
  return {
    updates: [],
    async sessionUpdate(params) {
      this.updates.push(params);
    },
  };
}

function makeTempStore(): { store: SessionStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(pathJoin(osTmpdir(), "glm-acp-test-recovery-"));
  const store = new SessionStore(dir);
  return {
    store,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Hand-write a session JSON file into the store directory, as a crashed process would have left it. */
function writeSessionRecord(dir: string, record: PersistedSession): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(pathJoin(dir, `${record.sessionId}.json`), JSON.stringify(record, null, 2));
}

function recordPath(dir: string, sessionId: string): string {
  return pathJoin(dir, `${sessionId}.json`);
}

function backupPath(dir: string, sessionId: string): string {
  return pathJoin(dir, `.${sessionId}.json.pre-v5.bak`);
}

/** Loose shape of an on-disk record, so assertions stay readable without `any`. */
interface RawRecord {
  schemaVersion?: number;
  activeTurn?: {
    turnId?: string;
    displayText?: Record<string, string>;
    pendingBatch?: { calls?: Array<{ id?: string; state?: string }> } | null;
  };
  displayText?: Record<string, string>;
  messages?: Array<{
    role: string;
    content?: unknown;
    tool_calls?: Array<{ id?: string }>;
  }>;
}

function readRawRecord(dir: string, sessionId: string): RawRecord {
  return JSON.parse(readFileSync(recordPath(dir, sessionId), "utf8")) as RawRecord;
}

function updateText(update: Record<string, unknown>): string | undefined {
  const inner = update.update as { sessionUpdate?: string; content?: { text?: string } } | undefined;
  return inner?.content?.text;
}

function isChunkKind(update: Record<string, unknown>, kind: string): boolean {
  const inner = update.update as { sessionUpdate?: string } | undefined;
  return inner?.sessionUpdate === kind;
}

function replayedUserTexts(conn: ConnectionStub): Array<string | undefined> {
  return conn.updates
    .filter((u) => isChunkKind(u, "user_message_chunk"))
    .map((u) => updateText(u));
}

function replayedNoteCount(conn: ConnectionStub): number {
  return conn.updates.filter(
    (u) => isChunkKind(u, "agent_message_chunk") && updateText(u) === INTERRUPTION_NOTE
  ).length;
}

/** A glm stub that records the exact message history of every provider call. */
function makeCapturingGlm(): {
  glm: { streamChat: (messages: GlmMessage[]) => AsyncGenerator<GlmStreamChunk> };
  calls: GlmMessage[][];
} {
  const calls: GlmMessage[][] = [];
  return {
    calls,
    glm: {
      async *streamChat(messages: GlmMessage[]): AsyncGenerator<GlmStreamChunk> {
        calls.push(structuredClone(messages));
        yield { text: "done" };
        yield { done: true, stopReason: "stop" };
      },
    },
  };
}

function initialize(agent: GlmAcpAgent): Promise<unknown> {
  return agent.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
}

/**
 * A v5 record whose process died right after a tool call started: the turn's
 * admitted user message and the staged-but-unsettled tool batch live under
 * `activeTurn`, and no tool result was ever recorded.
 */
function interruptedAfterToolStart(sessionId: string): PersistedSession {
  return {
    schemaVersion: 5,
    sessionId,
    cwd: "/tmp/project",
    title: "interrupted turn",
    updatedAt: "2026-09-20T10:00:00.000Z",
    model: "glm-5.3",
    mode: "default",
    thoughtLevel: "max",
    messages: [
      { role: "system", content: "you are a coding assistant" },
      { role: "user", content: "settle earlier work" },
      { role: "assistant", content: "Done." },
    ],
    activeTurn: {
      turnId: "t1",
      startedAt: "2026-09-20T10:00:05.000Z",
      messages: [{ role: "user", content: "fix it" }],
      pendingBatch: {
        assistant: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "write_file", arguments: "{}" },
            },
          ],
        },
        calls: [{ id: "call-1", name: "write_file", arguments: "{}", state: "started" }],
      },
    },
  };
}

function countInterruptionNotes(record: RawRecord): number {
  return (record.messages ?? []).filter(
    (m) => m.role === "assistant" && m.content === INTERRUPTION_NOTE
  ).length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("loadSession recovers a turn interrupted after a tool started", async () => {
  const { store, dir, cleanup } = makeTempStore();
  try {
    const sessionId = "aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    writeSessionRecord(dir, interruptedAfterToolStart(sessionId));

    const conn = createConnectionStub();
    const { glm, calls } = makeCapturingGlm();
    const agent = new GlmAcpAgent(conn as never, { glm, sessionStore: store });
    await initialize(agent);
    // An unrelated live session, so the load below exercises the disk path.
    await agent.newSession({ cwd: "/tmp", mcpServers: [] });

    await agent.loadSession({ sessionId, cwd: "/tmp/project", mcpServers: [] });

    // (a) The replay surfaces the admitted turn and the visible interruption
    // note (tool results stay internal — they are asserted via the provider
    // history below).
    assert.deepEqual(replayedUserTexts(conn), ["settle earlier work", "fix it"]);
    assert.equal(replayedNoteCount(conn), 1);

    // (b) The on-disk record is settled: no activeTurn, current schema, and
    // the interrupted exchange committed as legal history.
    const settled = readRawRecord(dir, sessionId);
    assert.equal(settled.activeTurn, undefined);
    assert.equal(settled.schemaVersion, SESSION_SCHEMA_VERSION);
    assert.deepEqual(
      (settled.messages ?? []).map((m) => m.role),
      ["system", "user", "assistant", "user", "assistant", "tool", "assistant"],
    );
    const toolMessages = (settled.messages ?? []).filter((m) => m.role === "tool");
    assert.equal(toolMessages.length, 1);
    assert.equal(toolMessages[0]?.content, UNKNOWN_OUTCOME_TEXT);

    // (c) The original interrupted record is preserved in the pre-v5 backup.
    const backup = JSON.parse(readFileSync(backupPath(dir, sessionId), "utf8")) as RawRecord;
    assert.ok(backup.activeTurn, "backup must still carry the interrupted turn");
    assert.equal(backup.activeTurn?.pendingBatch?.calls?.[0]?.state, "started");

    // The recovered history is provider-ready: the tool call is followed by
    // its unknown-outcome result and then the interruption note.
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "continue" }] });
    assert.ok(calls.length >= 1, "expected the prompt to reach the provider");
    const sent = calls[calls.length - 1] ?? [];
    const toolIndex = sent.findIndex(
      (m) => m.role === "tool" && m.content === UNKNOWN_OUTCOME_TEXT
    );
    assert.notEqual(toolIndex, -1, "expected the unknown-outcome tool result in provider history");
    const declared = sent[toolIndex - 1];
    assert.equal(declared?.role, "assistant");
    assert.equal(declared?.tool_calls?.[0]?.id, "call-1");
    const note = sent[toolIndex + 1];
    assert.equal(note?.role, "assistant");
    assert.equal(note?.content, INTERRUPTION_NOTE);
  } finally {
    cleanup();
  }
});

test("recovery is idempotent across a second load", async () => {
  const { store, dir, cleanup } = makeTempStore();
  try {
    const sessionId = "bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    writeSessionRecord(dir, interruptedAfterToolStart(sessionId));

    const first = createConnectionStub();
    const agent1 = new GlmAcpAgent(first as never, { sessionStore: store });
    await agent1.loadSession({ sessionId, cwd: "/tmp/project", mcpServers: [] });

    // A fresh agent simulates a second process start against the repaired record.
    const second = createConnectionStub();
    const agent2 = new GlmAcpAgent(second as never, { sessionStore: store });
    await agent2.loadSession({ sessionId, cwd: "/tmp/project", mcpServers: [] });

    const settled = readRawRecord(dir, sessionId);
    assert.equal(settled.activeTurn, undefined);
    assert.equal(countInterruptionNotes(settled), 1);
    const raw = readFileSync(recordPath(dir, sessionId), "utf8");
    assert.equal(raw.split(INTERRUPTION_NOTE).length - 1, 1);
    assert.equal(replayedNoteCount(second), 1);
  } finally {
    cleanup();
  }
});

test("display text survives the active-turn split", async () => {
  const { store, dir, cleanup } = makeTempStore();
  try {
    const sessionId = "cccc3333-cccc-cccc-cccc-cccccccccccc";
    writeSessionRecord(dir, {
      schemaVersion: 5,
      sessionId,
      cwd: "/tmp/project",
      title: "display split",
      updatedAt: "2026-09-20T10:00:00.000Z",
      model: "glm-5.3",
      mode: "default",
      messages: [{ role: "user", content: "expanded one body" }],
      displayText: { "0": "/cmd one" },
      activeTurn: {
        turnId: "t2",
        startedAt: "2026-09-20T10:00:05.000Z",
        messages: [{ role: "user", content: "expanded two body" }],
        pendingBatch: null,
        displayText: { "0": "/cmd two" },
      },
    });

    const conn = createConnectionStub();
    const agent = new GlmAcpAgent(conn as never, { sessionStore: store });
    await agent.loadSession({ sessionId, cwd: "/tmp/project", mcpServers: [] });

    // Both user turns replay with their DISPLAY text, not the expanded bodies.
    assert.deepEqual(replayedUserTexts(conn), ["/cmd one", "/cmd two"]);

    // The settled record merges the two display maps. The restore checkpoint
    // re-keys the merged indices onto the restored messages, which carry a
    // fresh system prompt at index 0, so both entries shift by one and stay
    // paired with the right user messages.
    const settled = readRawRecord(dir, sessionId);
    assert.equal(settled.activeTurn, undefined);
    assert.deepEqual(settled.displayText, { "1": "/cmd one", "2": "/cmd two" });
    const msgs = settled.messages ?? [];
    assert.equal(msgs[0]?.role, "system");
    assert.equal(msgs[1]?.content, "expanded one body");
    assert.equal(msgs[2]?.content, "expanded two body");
  } finally {
    cleanup();
  }
});

test("a failed provider call keeps the admitted user turn on disk", async () => {
  const { store, dir, cleanup } = makeTempStore();
  try {
    const glm = {
      // The provider must fail before producing any chunk, so this generator
      // deliberately never yields.
      // eslint-disable-next-line require-yield
      async *streamChat(): AsyncGenerator<GlmStreamChunk> {
        throw new Error("provider down");
      },
    };
    const agent = new GlmAcpAgent(createConnectionStub() as never, {
      glm,
      sessionStore: store,
    });
    await initialize(agent);
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

    await assert.rejects(
      () => agent.prompt({ sessionId, prompt: [{ type: "text", text: "fix it" }] }),
      /provider down/,
    );

    const settled = readRawRecord(dir, sessionId);
    assert.equal(settled.activeTurn, undefined);
    assert.equal(settled.schemaVersion, SESSION_SCHEMA_VERSION);
    const users = (settled.messages ?? []).filter((m) => m.role === "user");
    assert.equal(users.length, 1);
    assert.equal(users[0]?.content, "fix it");
  } finally {
    cleanup();
  }
});

test("admission checkpoint failure stops the turn before the provider call", async () => {
  let saveAttempts = 0;
  const failingStore = {
    load: () => undefined,
    save: () => {
      saveAttempts += 1;
      throw new Error("disk full");
    },
    listMetadata: () => [],
    backupPreV5: () => false,
  } as unknown as SessionStore;

  let streamChatCalls = 0;
  const glm = {
    async *streamChat(): AsyncGenerator<GlmStreamChunk> {
      streamChatCalls += 1;
      yield { done: true, stopReason: "stop" };
    },
  };

  const agent = new GlmAcpAgent(createConnectionStub() as never, {
    glm,
    sessionStore: failingStore,
  });
  await initialize(agent);
  const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

  await assert.rejects(
    () => agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] }),
    (err: unknown) =>
      err instanceof CheckpointError && /disk full/.test(err.message),
  );
  assert.ok(saveAttempts >= 1, "the admission checkpoint must have attempted a save");
  assert.equal(streamChatCalls, 0, "no provider call may follow a failed checkpoint");
});

test("fork of an interrupted record also recovers before forking", async () => {
  const { store, dir, cleanup } = makeTempStore();
  try {
    const sessionId = "dddd4444-dddd-dddd-dddd-dddddddddddd";
    writeSessionRecord(dir, interruptedAfterToolStart(sessionId));

    const agent = new GlmAcpAgent(createConnectionStub() as never, { sessionStore: store });
    await initialize(agent);

    const fork = await agent.unstable_forkSession({
      sessionId,
      cwd: "/tmp/fork",
      mcpServers: [],
    });
    assert.notEqual(fork.sessionId, sessionId);

    const forked = readRawRecord(dir, fork.sessionId);
    assert.equal(forked.activeTurn, undefined);
    assert.equal(forked.schemaVersion, SESSION_SCHEMA_VERSION);
    assert.deepEqual(
      (forked.messages ?? []).map((m) => m.role),
      ["system", "user", "assistant", "user", "assistant", "tool", "assistant"],
    );
    assert.equal(countInterruptionNotes(forked), 1);

    // The source record was settled by the fork's recovery pass as well.
    const parent = readRawRecord(dir, sessionId);
    assert.equal(parent.activeTurn, undefined);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Pre-v5 backup gating: the live record is replaced only once a durable
// rollback copy is in place (see the backupPreV5 unit tests for the store
// contract itself).
// ---------------------------------------------------------------------------

function posixPermissionsOnly(): boolean {
  return (process.platform as string) !== "win32" && (process.getuid?.() ?? 0) !== 0;
}

test("an unwritable store directory fails the load and leaves the interrupted record untouched", async () => {
  if (!posixPermissionsOnly()) return;
  const { store, dir, cleanup } = makeTempStore();
  try {
    const sessionId = "eeee5555-eeee-eeee-eeee-eeeeeeeeeeee";
    writeSessionRecord(dir, interruptedAfterToolStart(sessionId));
    const liveRaw = readFileSync(recordPath(dir, sessionId), "utf8");

    chmodSync(dir, 0o500);
    try {
      const agent = new GlmAcpAgent(createConnectionStub() as never, { sessionStore: store });
      await assert.rejects(
        () => agent.loadSession({ sessionId, cwd: "/tmp/project", mcpServers: [] }),
        /back up session/,
      );
    } finally {
      chmodSync(dir, 0o700);
    }

    assert.equal(
      readFileSync(recordPath(dir, sessionId), "utf8"),
      liveRaw,
      "the live record must not be replaced without its backup"
    );
    assert.equal(existsSync(backupPath(dir, sessionId)), false, "no backup may be claimed");
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes(".tmp")),
      []
    );
  } finally {
    cleanup();
  }
});

test("a directory occupying the backup path fails the load and leaves the record untouched", async () => {
  const { store, dir, cleanup } = makeTempStore();
  try {
    const sessionId = "ffff6666-ffff-ffff-ffff-ffffffffffff";
    writeSessionRecord(dir, interruptedAfterToolStart(sessionId));
    const liveRaw = readFileSync(recordPath(dir, sessionId), "utf8");
    mkdirSync(backupPath(dir, sessionId));

    const agent = new GlmAcpAgent(createConnectionStub() as never, { sessionStore: store });
    await assert.rejects(
      () => agent.loadSession({ sessionId, cwd: "/tmp/project", mcpServers: [] }),
      /back up session/,
    );

    assert.equal(
      readFileSync(recordPath(dir, sessionId), "utf8"),
      liveRaw,
      "the live record must not be replaced without its backup"
    );
    assert.equal(existsSync(backupPath(dir, sessionId)), true, "the occupying directory survives");
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes(".tmp")),
      []
    );
  } finally {
    cleanup();
  }
});

test("a pre-existing valid backup counts as success and recovery proceeds without rewriting it", async () => {
  const { store, dir, cleanup } = makeTempStore();
  try {
    const sessionId = "aaaa7777-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    writeSessionRecord(dir, interruptedAfterToolStart(sessionId));
    const originalRaw = readFileSync(recordPath(dir, sessionId), "utf8");
    writeFileSync(backupPath(dir, sessionId), originalRaw, "utf8");

    const conn = createConnectionStub();
    const agent = new GlmAcpAgent(conn as never, { sessionStore: store });
    await agent.loadSession({ sessionId, cwd: "/tmp/project", mcpServers: [] });

    const settled = readRawRecord(dir, sessionId);
    assert.equal(settled.activeTurn, undefined);
    assert.equal(countInterruptionNotes(settled), 1);
    assert.equal(
      readFileSync(backupPath(dir, sessionId), "utf8"),
      originalRaw,
      "a valid backup must be honoured, not rewritten"
    );
  } finally {
    cleanup();
  }
});

test("a partial leftover backup is replaced by a good one and recovery is not blocked", async () => {
  const { store, dir, cleanup } = makeTempStore();
  try {
    const sessionId = "bbbb8888-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    writeSessionRecord(dir, interruptedAfterToolStart(sessionId));
    // A torn file of the kind the old write-in-place backup could leave.
    writeFileSync(backupPath(dir, sessionId), '{"schemaVersion":5,"session', "utf8");

    const conn = createConnectionStub();
    const agent = new GlmAcpAgent(conn as never, { sessionStore: store });
    await agent.loadSession({ sessionId, cwd: "/tmp/project", mcpServers: [] });

    const settled = readRawRecord(dir, sessionId);
    assert.equal(settled.activeTurn, undefined);
    assert.equal(countInterruptionNotes(settled), 1);

    const backup = JSON.parse(
      readFileSync(backupPath(dir, sessionId), "utf8"),
    ) as RawRecord;
    assert.ok(backup.activeTurn, "the backup must hold the original interrupted record");
    assert.equal(backup.activeTurn?.pendingBatch?.calls?.[0]?.state, "started");
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes(".tmp")),
      []
    );
  } finally {
    cleanup();
  }
});
