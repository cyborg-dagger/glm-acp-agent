import test from "node:test";
import assert from "node:assert/strict";
import {
  UNKNOWN_OUTCOME_TEXT,
  recoverInterruptedSession,
} from "../protocol/session-recovery.js";
import type { GlmMessage } from "../llm/glm-client.js";
import type { PersistedSession } from "../protocol/session-store.js";

function baseRecord(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    schemaVersion: 5,
    sessionId: "session-1",
    cwd: "/tmp/project",
    title: "Recovery fixtures",
    updatedAt: "2026-09-20T10:00:00.000Z",
    model: "glm-5.3",
    mode: "default",
    thoughtLevel: "max",
    messages: [],
    ...overrides,
  };
}

function user(text: string): GlmMessage {
  return { role: "user", content: text };
}

function assistantWithTools(...calls: Array<{ id: string; name: string }>): GlmMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: "{}" },
    })),
  };
}

function toolResult(id: string, content: string): GlmMessage {
  return { role: "tool", tool_call_id: id, content };
}

function activeTurn(overrides: Partial<NonNullable<PersistedSession["activeTurn"]>> = {}) {
  return {
    turnId: "turn-1",
    startedAt: "2026-09-20T10:00:01.000Z",
    messages: [user("list the files")],
    pendingBatch: null,
    ...overrides,
  };
}

test("a clean v5 record without activeTurn passes through unchanged", () => {
  const record = baseRecord({ messages: [user("hi"), { role: "assistant", content: "hello" }] });
  const recovered = recoverInterruptedSession(record);
  assert.deepEqual(recovered.messages, record.messages);
  assert.equal(recovered.activeTurn, undefined);
  assert.equal(recovered, record, "no interruption means no copy is needed");
});

test("a settled activeTurn without a pending batch commits its suffix into canonical history", () => {
  const record = baseRecord({
    messages: [user("first turn"), { role: "assistant", content: "done" }],
    activeTurn: activeTurn({
      messages: [user("second turn"), { role: "assistant", content: "also done" }],
    }),
  });
  const recovered = recoverInterruptedSession(record);
  assert.deepEqual(
    recovered.messages?.map((m) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal(recovered.activeTurn, undefined);
});

test("a queued-but-not-started call recovers as not started", () => {
  const record = baseRecord({
    activeTurn: activeTurn({
      pendingBatch: {
        assistant: assistantWithTools({ id: "call-1", name: "write_file" }),
        calls: [{ id: "call-1", name: "write_file", arguments: "{}", state: "queued" }],
      },
    }),
  });
  const recovered = recoverInterruptedSession(record);
  // tail = [assistant batch, tool result, interruption note]
  const batch = recovered.messages?.slice(-3);
  assert.deepEqual(batch?.[0], assistantWithTools({ id: "call-1", name: "write_file" }));
  assert.equal(batch?.[1]?.role, "tool");
  assert.match(String(batch?.[1]?.content ?? ""), /not started|never started/i);
  assert.match(String(batch?.[2]?.content ?? ""), /interrupt/i);
});

test("a started-but-unrecorded call recovers as unknown outcome with the exact wording", () => {
  const record = baseRecord({
    activeTurn: activeTurn({
      pendingBatch: {
        assistant: assistantWithTools({ id: "call-1", name: "write_file" }),
        calls: [{ id: "call-1", name: "write_file", arguments: "{}", state: "started" }],
      },
    }),
  });
  const recovered = recoverInterruptedSession(record);
  assert.equal(String(recovered.messages?.at(-2)?.content ?? ""), UNKNOWN_OUTCOME_TEXT);
  assert.match(String(recovered.messages?.at(-1)?.content ?? ""), /interrupt/i);
  assert.match(UNKNOWN_OUTCOME_TEXT, /outcome is unknown/i);
  assert.match(UNKNOWN_OUTCOME_TEXT, /inspect the current state/i);
});

test("recorded results are preserved and a visible interruption note is added", () => {
  const record = baseRecord({
    activeTurn: activeTurn({
      pendingBatch: {
        assistant: assistantWithTools(
          { id: "call-1", name: "write_file" },
          { id: "call-2", name: "run_command" },
        ),
        calls: [
          { id: "call-1", name: "write_file", arguments: "{}", state: "recorded", result: "wrote 3 lines" },
          { id: "call-2", name: "run_command", arguments: "{}", state: "started" },
        ],
      },
    }),
  });
  const recovered = recoverInterruptedSession(record);
  const tail = recovered.messages?.slice(-4) ?? [];
  assert.equal(tail[0]?.role, "assistant");
  assert.equal(String(tail[1]?.content ?? ""), "wrote 3 lines");
  assert.equal(String(tail[2]?.content ?? ""), UNKNOWN_OUTCOME_TEXT);
  const note = tail[3];
  assert.equal(note?.role, "assistant");
  assert.match(String(note?.content ?? ""), /interrupt/i);
});

test("recovery is idempotent: a recovered record needs no further repair", () => {
  const record = baseRecord({
    activeTurn: activeTurn({
      pendingBatch: {
        assistant: assistantWithTools({ id: "call-1", name: "write_file" }),
        calls: [{ id: "call-1", name: "write_file", arguments: "{}", state: "started" }],
      },
    }),
  });
  const once = recoverInterruptedSession(record);
  const twice = recoverInterruptedSession(once);
  assert.equal(twice, once);
});

test("activeTurn displayText indices are remapped onto the merged history", () => {
  const record = baseRecord({
    messages: [user("turn one")],
    displayText: { "0": "/command one" },
    activeTurn: activeTurn({
      messages: [user("/command two expanded")],
      displayText: { "0": "/command two" },
      pendingBatch: null,
    }),
  });
  const recovered = recoverInterruptedSession(record);
  assert.deepEqual(recovered.displayText, { "0": "/command one", "1": "/command two" });
});

test("a legacy terminal unmatched tool batch gets unknown outcomes for missing ids only", () => {
  const record = baseRecord({
    schemaVersion: 4,
    messages: [
      user("do things"),
      assistantWithTools({ id: "a", name: "write_file" }, { id: "b", name: "run_command" }),
      toolResult("a", "wrote file"),
    ],
  });
  const recovered = recoverInterruptedSession(record);
  assert.equal(recovered.messages?.length, 4);
  const declared = (recovered.messages?.[1] as { tool_calls?: unknown[] })?.tool_calls;
  assert.equal(declared?.length, 2);
  assert.equal(String(recovered.messages?.[2]?.content ?? ""), "wrote file");
  assert.match(String(recovered.messages?.[3]?.content ?? ""), /unknown from interrupted legacy session/i);
  assert.equal(recovered.schemaVersion, 5);
});

test("legacy records with matched batches or a clean tail are left alone", () => {
  const clean = baseRecord({
    schemaVersion: 4,
    messages: [
      user("done talking"),
      assistantWithTools({ id: "a", name: "write_file" }),
      toolResult("a", "wrote file"),
      { role: "assistant", content: "all set" },
    ],
  });
  assert.equal(recoverInterruptedSession(clean), clean);
});

test("middle-of-history corruption is not repaired by deleting data", () => {
  // An assistant tool batch in the middle with a missing result is not a
  // terminal interruption; recovery must not append or delete anything.
  const record = baseRecord({
    schemaVersion: 4,
    messages: [
      user("first"),
      assistantWithTools({ id: "a", name: "write_file" }),
      toolResult("a", "ok"),
      { role: "assistant", content: "middle" },
      user("second"),
      assistantWithTools({ id: "b", name: "run_command" }),
      toolResult("b", "ran"),
      { role: "assistant", content: "final answer" },
    ],
  });
  assert.equal(recoverInterruptedSession(record), record);
});

test("an interrupted legacy tail with zero recorded results recovers every call", () => {
  const record = baseRecord({
    schemaVersion: 3,
    messages: [user("x"), assistantWithTools({ id: "only", name: "web_search" })],
  });
  const recovered = recoverInterruptedSession(record);
  assert.equal(recovered.messages?.length, 3);
  assert.match(String(recovered.messages?.at(-1)?.content ?? ""), /unknown from interrupted legacy session/i);
});
