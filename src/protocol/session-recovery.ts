import type { GlmMessage } from "../llm/glm-client.js";
import type { PersistedSession } from "./session-store.js";

/**
 * Recovery of interrupted agent turns (schema v5) and legacy terminal tool
 * batches (v1–v4). This module is a pure function over persisted records: it
 * never invokes an executor, never repeats a side effect, and only ever
 * appends information — recorded results are preserved and missing outcomes
 * are labelled as unknown instead of guessed.
 */

/** A required persistence checkpoint failed; the operation it guards must not start or continue. */
export class CheckpointError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CheckpointError";
  }
}

/**
 * Hook invoked inside each executor handler after validation and permission,
 * immediately before the tool's filesystem/process/network/MCP effect. A
 * rejection must prevent that effect from starting.
 */
export interface ToolExecutionHooks {
  onExecutionStart(call: { id: string; name: string }): Promise<void>;
}

export const UNKNOWN_OUTCOME_TEXT =
  "The agent stopped after this tool was started but before its result was recorded.\n" +
  "Its outcome is unknown. Inspect the current state before repeating any side effect.";

export const NOT_STARTED_TEXT =
  "This tool call was queued but never started (the agent stopped before execution began). It had no effect.";

export const LEGACY_UNKNOWN_TEXT =
  "outcome unknown from interrupted legacy session: the agent stopped before this " +
  "result was recorded. Inspect the current state before repeating any side effect.";

export const INTERRUPTION_NOTE =
  "[The previous turn was interrupted before it finished. Unfinished tool calls above were " +
  "settled as not started or unknown outcome; no side effect was repeated during recovery.]";

/**
 * Settle an interrupted session record into legal, provider-ready history:
 *
 * - A clean record (no `activeTurn`, no legacy unmatched tail) is returned as-is.
 * - A v5 `activeTurn` is committed into the canonical `messages`, with each
 *   pending call recovered as recorded (preserved), started (unknown outcome)
 *   or queued (not started), followed by one visible interruption note.
 * - A legacy (v1–v4) terminal assistant tool batch missing results gets an
 *   `outcome unknown from interrupted legacy session` result appended for each
 *   missing id — recorded results are kept and nothing is deleted.
 *
 * The result never carries an `activeTurn`, so recovery is idempotent.
 */
export function recoverInterruptedSession(record: PersistedSession): PersistedSession {
  const activeTurn = record.activeTurn;
  if (activeTurn) return recoverActiveTurn(record, activeTurn);
  if (record.schemaVersion === undefined || record.schemaVersion < 5) {
    const repaired = repairLegacyTail(record);
    if (repaired !== record) return withSchemaVersion(repaired);
  }
  return record;
}

function recoverActiveTurn(record: PersistedSession, activeTurn: NonNullable<PersistedSession["activeTurn"]>): PersistedSession {
  const prefix = record.messages ?? [];
  const suffix = activeTurn.messages ?? [];
  const settled: GlmMessage[] = [...prefix, ...suffix];

  if (activeTurn.pendingBatch) {
    settled.push(activeTurn.pendingBatch.assistant);
    for (const call of activeTurn.pendingBatch.calls) {
      settled.push({
        role: "tool",
        tool_call_id: call.id,
        content: outcomeFor(call),
      });
    }
    // One visible note, and only when something was actually unfinished: a
    // turn interrupted between exchanges needs no repair commentary.
    settled.push({ role: "assistant", content: INTERRUPTION_NOTE });
  }

  const displayText = mergeDisplayText(record, activeTurn, prefix.length);
  const recovered: PersistedSession = {
    ...record,
    messages: settled,
    schemaVersion: 5,
  };
  delete recovered.activeTurn;
  if (displayText) recovered.displayText = displayText;
  else delete recovered.displayText;
  return recovered;
}

function outcomeFor(call: { state: string; result?: string }): string {
  if (call.state === "recorded") return call.result ?? UNKNOWN_OUTCOME_TEXT;
  if (call.state === "started") return UNKNOWN_OUTCOME_TEXT;
  return NOT_STARTED_TEXT;
}

function mergeDisplayText(
  record: PersistedSession,
  activeTurn: NonNullable<PersistedSession["activeTurn"]>,
  prefixLength: number,
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  let any = false;
  for (const [index, text] of Object.entries(record.displayText ?? {})) {
    merged[index] = text;
    any = true;
  }
  for (const [index, text] of Object.entries(activeTurn.displayText ?? {})) {
    merged[String(prefixLength + Number(index))] = text;
    any = true;
  }
  return any ? merged : undefined;
}

/**
 * Append unknown-outcome results for the ids of a terminal legacy assistant
 * tool batch that never received them. Middle-of-history damage and orphan
 * results are left untouched; only a terminal batch is a crash marker.
 *
 * Exported for the session store, which must run this repair while the
 * record still carries its on-disk schema version — before the parser
 * normalizes it to 5 and the legacy branch of `recoverInterruptedSession`
 * becomes unreachable (see `parsePersistedSession`).
 */
export function repairLegacyTail(record: PersistedSession): PersistedSession {
  const messages = record.messages ?? [];
  // Walk back over the trailing run of tool results; the terminal exchange is
  // the assistant message (if any) that declared them.
  let index = messages.length - 1;
  while (index >= 0 && messages[index]?.role === "tool") index -= 1;
  const batchMessage = index >= 0 ? messages[index] : undefined;
  const declaredCalls = batchMessage?.role === "assistant"
    ? (batchMessage as { tool_calls?: Array<{ id: string }> }).tool_calls
    : undefined;
  if (!batchMessage || !Array.isArray(declaredCalls) || declaredCalls.length === 0) {
    return record;
  }
  const answered = new Set(
    messages
      .slice(index + 1)
      .filter((message): message is Extract<GlmMessage, { role: "tool" }> => message.role === "tool")
      .map((message) => message.tool_call_id),
  );
  const missing = declaredCalls.filter((call) => !answered.has(call.id));
  if (missing.length === 0) return record;
  return {
    ...record,
    messages: [
      ...messages,
      ...missing.map((call): GlmMessage => ({
        role: "tool",
        tool_call_id: call.id,
        content: LEGACY_UNKNOWN_TEXT,
      })),
    ],
  };
}

function withSchemaVersion(record: PersistedSession): PersistedSession {
  return { ...record, schemaVersion: 5 };
}
