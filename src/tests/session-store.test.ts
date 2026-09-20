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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlmMessage } from "../llm/glm-client.js";
import {
  SESSION_SCHEMA_VERSION,
  SessionStore,
  type PendingToolBatch,
  type PendingToolCall,
  type PendingToolCallState,
  type PersistedActiveTurn,
  type PersistedSession,
} from "../protocol/session-store.js";
import { LEGACY_UNKNOWN_TEXT } from "../protocol/session-recovery.js";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "glm-acp-session-store-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function validSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    sessionId: "session-1",
    cwd: "/tmp/project",
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
    title: "A session",
    updatedAt: "2026-09-16T10:00:00.000Z",
    model: "glm-5.3",
    mode: "default",
    thoughtLevel: "max",
    ...overrides,
  };
}

function writeRaw(dir: string, sessionId: string, value: unknown): void {
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(value), "utf8");
}

function assistantWithToolCalls(ids: string[]): GlmMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: ids.map((id) => ({
      id,
      type: "function" as const,
      function: { name: "run_tool", arguments: "{}" },
    })),
  };
}

function pendingToolCall(
  id: string,
  state: PendingToolCallState,
  result?: string,
): PendingToolCall {
  return result === undefined
    ? { id, name: "run_tool", arguments: "{}", state }
    : { id, name: "run_tool", arguments: "{}", state, result };
}

function validActiveTurn(overrides: Partial<PersistedActiveTurn> = {}): PersistedActiveTurn {
  return {
    turnId: "turn-1",
    startedAt: "2026-09-20T10:00:01.000Z",
    messages: [{ role: "user", content: "run the tools" }],
    pendingBatch: {
      assistant: assistantWithToolCalls(["a", "b"]),
      calls: [pendingToolCall("a", "recorded", "ok"), pendingToolCall("b", "started")],
    },
    ...overrides,
  };
}

test("load and listMetadata skip null, primitive, and array JSON roots", () => {
  const dir = makeDir();
  try {
    const store = new SessionStore(dir);
    for (const [index, value] of [null, 7, "session", true, []].entries()) {
      const id = `invalid-root-${index}`;
      writeRaw(dir, id, value);
      assert.equal(store.load(id), undefined, `load should reject ${String(value)}`);
    }

    assert.doesNotThrow(() => store.listMetadata());
    assert.deepEqual(store.listMetadata(), []);
  } finally {
    cleanup(dir);
  }
});

test("load rejects malformed metadata, mismatched ids, and unsupported versions", () => {
  const dir = makeDir();
  try {
    const store = new SessionStore(dir);
    const base = validSession();
    const malformed: Array<[string, unknown]> = [
      ["missing-session-id", { ...base, sessionId: undefined }],
      ["mismatched-id", { ...base, sessionId: "some-other-session" }],
      ["bad-cwd", { ...base, cwd: 12 }],
      ["bad-title", { ...base, title: 12 }],
      ["bad-updated-at", { ...base, updatedAt: null }],
      ["bad-model", { ...base, model: false }],
      ["bad-mode", { ...base, mode: "all" }],
      ["bad-thought-level", { ...base, thoughtLevel: "ultra" }],
      ["bad-display-text", { ...base, displayText: { "0": 12 } }],
      ["bad-display-text-root", { ...base, displayText: [] }],
      ["bad-version-type", { ...base, schemaVersion: "4" }],
      // 5 is the current schema; use a genuinely-future version so this case
      // keeps rejecting on the version check, not an accidental id mismatch.
      ["unsupported-version", { ...base, schemaVersion: 99 }],
      ["old-version-zero", { ...base, schemaVersion: 0 }],
    ];

    for (const [id, value] of malformed) {
      writeRaw(dir, id, value);
      assert.equal(store.load(id), undefined, `load should reject ${id}`);
    }

    assert.doesNotThrow(() => store.listMetadata());
    assert.deepEqual(store.listMetadata(), []);
  } finally {
    cleanup(dir);
  }
});

test("load rejects malformed messages but accepts supported GlmMessage shapes", () => {
  const dir = makeDir();
  try {
    const store = new SessionStore(dir);
    const invalidMessages: Array<[string, unknown]> = [
      ["messages-null", null],
      ["messages-object", { role: "user", content: "hello" }],
      ["message-null", [null]],
      ["message-primitive", ["hello"]],
      ["message-bad-role", [{ role: "narrator", content: "hello" }]],
      ["message-bad-content", [{ role: "user", content: 42 }]],
      ["message-bad-content-part", [{ role: "user", content: [{}] }]],
      [
        "message-empty-file-part",
        [{ role: "user", content: [{ type: "file", file: {} }] }],
      ],
      [
        "message-file-non-string-filename",
        [{ role: "user", content: [{ type: "file", file: { file_id: "id", filename: 42 } }] }],
      ],
      [
        "message-file-null-data",
        [{ role: "user", content: [{ type: "file", file: { file_id: "id", file_data: null } }] }],
      ],
      [
        "message-file-empty-id",
        [{ role: "user", content: [{ type: "file", file: { file_id: "" } }] }],
      ],
      [
        "message-user-refusal-part",
        [{ role: "user", content: [{ type: "refusal", refusal: "no" }] }],
      ],
      [
        "message-assistant-file-part",
        [{ role: "assistant", content: [{ type: "file", file: { file_id: "id" } }] }],
      ],
      ["message-missing-content", [{ role: "user" }]],
      ["message-tool-missing-id", [{ role: "tool", content: "result" }]],
      ["message-tool-null-content", [{ role: "tool", tool_call_id: "call-1", content: null }]],
      [
        "message-bad-tool-calls",
        [{ role: "assistant", content: null, tool_calls: [{ id: 42 }] }],
      ],
      [
        "message-tool-call-missing-function",
        [{ role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function" }] }],
      ],
      [
        "message-malformed-function-call",
        [{ role: "assistant", content: null, function_call: { name: 42, arguments: null } }],
      ],
      [
        "message-user-tool-calls",
        [{ role: "user", content: "hello", tool_calls: [] }],
      ],
    ];
    for (const [id, messages] of invalidMessages) {
      writeRaw(dir, id, { ...validSession({ sessionId: id }), messages });
      assert.equal(store.load(id), undefined, `load should reject ${id}`);
    }

    const supported = validSession({
      sessionId: "supported-shapes",
      messages: [
        { role: "developer", content: [{ type: "text", text: "rules" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "inspect this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
            { type: "file", file: { file_data: "encoded-file", filename: "notes.txt" } },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "refusal", refusal: "not needed" }],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"x"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "file contents" },
      ],
    });
    writeRaw(dir, supported.sessionId, supported);
    assert.deepEqual(store.load(supported.sessionId)?.messages, supported.messages);
  } finally {
    cleanup(dir);
  }
});

test("load migrates valid v1 through v4 records without losing fields", () => {
  const dir = makeDir();
  try {
    const store = new SessionStore(dir);
    const records: Array<[string, Record<string, unknown>]> = [
      ["v1", { ...validSession({ sessionId: "v1" }), schemaVersion: undefined, mode: undefined, thoughtLevel: undefined }],
      ["v2", { ...validSession({ sessionId: "v2" }), schemaVersion: 2, thoughtLevel: undefined }],
      ["v3", { ...validSession({ sessionId: "v3" }), schemaVersion: 3, displayText: undefined }],
      ["v4", { ...validSession({ sessionId: "v4" }), schemaVersion: 4, displayText: { "1": "hello" } }],
    ];
    for (const [id, value] of records) {
      writeRaw(dir, id, value);
      const loaded = store.load(id);
      assert.equal(loaded?.schemaVersion, SESSION_SCHEMA_VERSION, id);
      assert.equal(loaded?.sessionId, id);
      assert.equal(loaded?.thoughtLevel, "max", id);
      assert.equal(loaded?.mode, "default", id);
      if (id === "v4") assert.deepEqual(loaded?.displayText, { "1": "hello" });
    }
  } finally {
    cleanup(dir);
  }
});

test("save atomically replaces a broad-mode record and keeps the file private", () => {
  const dir = makeDir();
  try {
    const store = new SessionStore(dir);
    const first = validSession({ updatedAt: "2026-09-16T10:00:00.000Z" });
    store.save(first);
    const path = join(dir, `${first.sessionId}.json`);
    chmodSync(path, 0o666);

    const second = validSession({
      title: "Replaced session",
      updatedAt: "2026-09-16T11:00:00.000Z",
      messages: [...first.messages, { role: "user", content: "new turn" }],
    });
    store.save(second);

    // POSIX exposes the mode bits; Windows does not provide this permission
    // contract, while the replacement/load/temporary-file assertions remain
    // meaningful on every supported platform.
    if ((process.platform as string) !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    assert.deepEqual(store.load(first.sessionId), { ...second, schemaVersion: SESSION_SCHEMA_VERSION });
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp")), []);
  } finally {
    cleanup(dir);
  }
});

test("save cleans up its temporary file when replacement fails", () => {
  const dir = makeDir();
  try {
    const store = new SessionStore(dir);
    const session = validSession({ sessionId: "rename-fails" });
    const target = join(dir, `${session.sessionId}.json`);
    mkdirSync(target);

    assert.throws(() => store.save(session));
    assert.equal(existsSync(target), true);
    assert.equal(statSync(target).isDirectory(), true);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes(".tmp")),
      [],
      "failed atomic save must not leave temporary artifacts"
    );
  } finally {
    cleanup(dir);
  }
});

test("save preserves the prior record when serializing the replacement fails", () => {
  const dir = makeDir();
  try {
    const store = new SessionStore(dir);
    const first = validSession({ sessionId: "serialization-fails" });
    store.save(first);
    const path = join(dir, `${first.sessionId}.json`);
    const before = readFileSync(path, "utf8");
    const cyclicMessage = { role: "user", content: "bad" } as Record<string, unknown>;
    cyclicMessage.self = cyclicMessage;

    assert.throws(() =>
      store.save(validSession({ sessionId: first.sessionId, messages: [cyclicMessage] as never }))
    );
    assert.equal(readFileSync(path, "utf8"), before);
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp")), []);
  } finally {
    cleanup(dir);
  }
});

test("v5 roundtrip preserves an in-flight activeTurn with a mixed-state pending batch", () => {
  const dir = makeDir();
  try {
    const store = new SessionStore(dir);
    const record: PersistedSession = {
      ...validSession({ sessionId: "active-turn-roundtrip" }),
      schemaVersion: SESSION_SCHEMA_VERSION,
      activeTurn: validActiveTurn(),
    };

    store.save(record);
    const loaded = store.load(record.sessionId);
    assert.deepEqual(loaded, { ...record, schemaVersion: SESSION_SCHEMA_VERSION });
    assert.deepEqual(loaded?.activeTurn, record.activeTurn);
    assert.deepEqual(
      loaded?.activeTurn?.pendingBatch?.calls,
      [pendingToolCall("a", "recorded", "ok"), pendingToolCall("b", "started")],
      "the ledger's mixed states and its recorded result must survive the roundtrip exactly"
    );
  } finally {
    cleanup(dir);
  }
});

test("malformed activeTurn records are rejected, not partially loaded", () => {
  const dir = makeDir();
  try {
    const store = new SessionStore(dir);

    // Positive control: the unmutated record loads, so every rejection below
    // is attributable to its single defect.
    const sound = validSession({ sessionId: "active-turn-sound", activeTurn: validActiveTurn() });
    writeRaw(dir, sound.sessionId, { ...sound, schemaVersion: 5 });
    assert.notEqual(store.load(sound.sessionId), undefined, "the intact base record must load");

    const defects: Array<[string, (turn: PersistedActiveTurn) => void]> = [
      [
        "active-turn-bad-state",
        (turn) => {
          ((turn.pendingBatch as PendingToolBatch).calls[0] as { state: string }).state = "finished";
        },
      ],
      [
        "active-turn-recorded-without-result",
        (turn) => {
          delete (turn.pendingBatch as PendingToolBatch).calls[0].result;
        },
      ],
      [
        "active-turn-queued-with-result",
        (turn) => {
          ((turn.pendingBatch as PendingToolBatch).calls[1] as { result?: string }).result = "early";
        },
      ],
      [
        "active-turn-undeclared-ledger-id",
        (turn) => {
          ((turn.pendingBatch as PendingToolBatch).calls[1] as { id: string }).id = "c";
        },
      ],
      [
        "active-turn-assistant-without-tool-calls",
        (turn) => {
          (turn.pendingBatch as PendingToolBatch).assistant = { role: "assistant", content: "no tools here" };
        },
      ],
      [
        "active-turn-message-is-primitive",
        (turn) => {
          turn.messages = ["not-a-message" as unknown as GlmMessage];
        },
      ],
      [
        "active-turn-bad-started-at",
        (turn) => {
          turn.startedAt = "not-a-date";
        },
      ],
    ];

    for (const [id, mutate] of defects) {
      const turn = validActiveTurn();
      mutate(turn);
      writeRaw(dir, id, { ...validSession({ sessionId: id }), schemaVersion: 5, activeTurn: turn });
      assert.equal(store.load(id), undefined, `load should reject ${id}`);
    }

    assert.deepEqual(
      store.listMetadata().map((entry) => entry.sessionId),
      [sound.sessionId],
      "no record with a malformed activeTurn may surface in listings"
    );
  } finally {
    cleanup(dir);
  }
});

test("legacy v4 dangling tool calls are settled with unknown outcomes through the v5 parser", () => {
  const dir = makeDir();
  try {
    const store = new SessionStore(dir);
    const v4: PersistedSession = validSession({
      sessionId: "v4-dangling-tool-calls",
      schemaVersion: 4,
      displayText: { "1": "run the tools" },
      messages: [
        { role: "user", content: "run the tools" },
        assistantWithToolCalls(["a", "b"]),
      ],
    });

    writeRaw(dir, v4.sessionId, v4);
    const loaded = store.load(v4.sessionId);
    assert.equal(loaded?.schemaVersion, SESSION_SCHEMA_VERSION);
    // The parser must repair the dangling tail while the record still carries
    // its on-disk v4 version: normalizing to 5 first would hide it from the
    // legacy branch of recoverInterruptedSession forever.
    assert.deepEqual(
      loaded?.messages,
      [
        { role: "user", content: "run the tools" },
        assistantWithToolCalls(["a", "b"]),
        { role: "tool", tool_call_id: "a", content: LEGACY_UNKNOWN_TEXT },
        { role: "tool", tool_call_id: "b", content: LEGACY_UNKNOWN_TEXT },
      ],
      "a dangling legacy tool-call tail must be settled at load time"
    );
    assert.deepEqual(loaded?.displayText, { "1": "run the tools" });
    assert.equal(loaded?.mode, "default");
    assert.equal(loaded?.thoughtLevel, "max");
    assert.equal(loaded?.activeTurn, undefined);
  } finally {
    cleanup(dir);
  }
});

test("backupPreV5 writes a private exclusive backup exactly once", () => {
  const dir = makeDir();
  try {
    const store = new SessionStore(dir);
    const first = validSession({ sessionId: "backup-once", updatedAt: "2026-09-16T10:00:00.000Z" });
    store.save(first);
    const livePath = join(dir, `${first.sessionId}.json`);
    const backupPath = join(dir, `.${first.sessionId}.json.pre-v5.bak`);
    const originalRaw = readFileSync(livePath, "utf8");

    assert.equal(store.backupPreV5(first.sessionId), true, "the first backup must be written");
    assert.equal(existsSync(backupPath), true);
    assert.equal(readFileSync(backupPath, "utf8"), originalRaw);
    // POSIX exposes the mode bits; Windows does not provide this permission
    // contract, while the exclusivity and content assertions remain meaningful
    // on every supported platform.
    if ((process.platform as string) !== "win32") {
      assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    }

    store.save(validSession({
      sessionId: first.sessionId,
      title: "Replaced after the backup",
      updatedAt: "2026-09-16T11:00:00.000Z",
    }));
    assert.equal(
      store.backupPreV5(first.sessionId),
      false,
      "a second backup must not overwrite the first"
    );
    assert.equal(
      readFileSync(backupPath, "utf8"),
      originalRaw,
      "the backup must still hold the original pre-v5 content"
    );

    assert.equal(store.backupPreV5("never-saved"), false, "a missing source means no backup");
    assert.equal(store.backupPreV5("../escaped"), false, "unsafe ids are refused, not thrown");
  } finally {
    cleanup(dir);
  }
});
