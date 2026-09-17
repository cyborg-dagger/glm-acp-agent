import type { GlmMessage } from "../llm/glm-client.js";
import { boundToolResult } from "../tools/tool-output.js";

export interface ContextBudget {
  contextWindow: number;
  maxOutputTokens: number;
  toolSchemaTokens: number;
  safetyTokens: number;
}

export interface CompactionResult {
  messages: GlmMessage[];
  changed: boolean;
  removedExchanges: number;
  reducedToolResults: number;
  estimatedTokens: number;
}

const IMAGE_PART_TOKENS = 1600;
const MESSAGE_OVERHEAD_TOKENS = 4;
const ACTIVE_TOOL_RESULT_BYTES = 4096;

/** A deliberately labelled heuristic; providers do not expose their tokenizer. */
export function estimateMessagesTokens(messages: readonly GlmMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function availableInputTokens(budget: ContextBudget): number {
  return budget.contextWindow - budget.maxOutputTokens - budget.toolSchemaTokens - budget.safetyTokens;
}

export function estimateSerializedTokens(value: unknown): number {
  const text = JSON.stringify(value);
  return Math.max(Math.ceil(text.length / 4), Math.ceil(Buffer.byteLength(text, "utf8") / 2));
}

/** Guard against retaining a tool result whose matching assistant call was removed. */
export function assertValidHistory(messages: readonly GlmMessage[]): void {
  const calls = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) calls.add(call.id);
    if (message.role === "tool" && !calls.has(message.tool_call_id)) {
      throw new Error(`invalid history: tool result ${message.tool_call_id} has no retained assistant call`);
    }
  }
}

/** Compact only complete user exchanges; the final user exchange remains live. */
export function compactToBudget(
  messages: readonly GlmMessage[],
  budget: ContextBudget,
  force: boolean,
): CompactionResult {
  const available = availableInputTokens(budget);
  const initial = estimateMessagesTokens(messages);
  if (messages.length <= 1 || (!force && initial <= Math.floor(available * 0.9))) {
    return { messages: [...messages], changed: false, removedExchanges: 0, reducedToolResults: 0, estimatedTokens: initial };
  }
  const target = Math.floor(available * 0.8);
  const desired = force ? Math.min(target, Math.floor(initial / 2)) : target;
  const system = messages[0]?.role === "system" ? messages[0] : undefined;
  const turns = groupTurns(system ? messages.slice(1) : messages);
  if (turns.length === 0) return { messages: [...messages], changed: false, removedExchanges: 0, reducedToolResults: 0, estimatedTokens: initial };

  const currentTurns = turns.map(turn => [...turn]);
  let reducedToolResults = 0;
  let removedExchanges = 0;
  const currentMessages = () => [...(system ? [system] : []), ...currentTurns.flat()];
  let estimate = estimateMessagesTokens(currentMessages());

  // When the live exchange itself is the issue, retain its assistant calls and
  // reasoning verbatim, but shorten only old tool-result bodies in it.
  const activeIndex = currentTurns.length - 1;
  if (estimate > desired) {
    const active = currentTurns[activeIndex]!;
    currentTurns[activeIndex] = active.map(message => {
      if (message.role !== "tool" || typeof message.content !== "string" || Buffer.byteLength(message.content, "utf8") <= ACTIVE_TOOL_RESULT_BYTES) return message;
      reducedToolResults += 1;
      return { ...message, content: boundToolResult(message.content, ACTIVE_TOOL_RESULT_BYTES) } as GlmMessage;
    });
    estimate = estimateMessagesTokens(currentMessages());
  }

  // Preserve the newest complete exchange whenever it fits. Older completed
  // exchanges are removed whole, so tool IDs never dangle from their calls.
  // Ten recent user turns are normally retained for conversational cohesion.
  // An actual provider overflow uses force and may yield this preference.
  const minimumTurns = force ? 1 : 10;
  while (estimate > desired && currentTurns.length > minimumTurns) {
    currentTurns.shift();
    removedExchanges += 1;
    estimate = estimateMessagesTokens(currentMessages());
  }

  const compacted = currentMessages();
  return {
    messages: compacted,
    changed: removedExchanges > 0 || reducedToolResults > 0,
    removedExchanges,
    reducedToolResults,
    estimatedTokens: estimate,
  };
}

export function appendCompactionNote(message: GlmMessage, removed: number, reduced: number): GlmMessage {
  const note = `[Context compaction: omitted ${removed} completed exchange${removed === 1 ? "" : "s"}; shortened ${reduced} tool result${reduced === 1 ? "" : "s"}. The original user request remains above.]`;
  if (typeof message.content === "string") return { ...message, content: `${message.content}\n\n${note}` } as GlmMessage;
  if (Array.isArray(message.content)) return { ...message, content: [...message.content, { type: "text", text: note }] } as GlmMessage;
  return { ...message, content: note } as GlmMessage;
}

function groupTurns(messages: readonly GlmMessage[]): GlmMessage[][] {
  const turns: GlmMessage[][] = [];
  let current: GlmMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function estimateMessageTokens(message: GlmMessage): number {
  let bytes = 0;
  let chars = 0;
  let images = 0;
  const add = (text: string) => { bytes += Buffer.byteLength(text, "utf8"); chars += text.length; };
  if (typeof message.content === "string") add(message.content);
  else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "image_url") images += 1;
      else if ("text" in part && typeof part.text === "string") add(part.text);
    }
  }
  if (message.role === "assistant") {
    if (message.reasoning_content) add(message.reasoning_content);
    for (const call of message.tool_calls ?? []) {
      if ("function" in call) { add(call.function.name); add(call.function.arguments); }
    }
  }
  // This uses both UTF-16 characters and UTF-8 bytes to avoid treating CJK as
  // cheap English text. It remains a heuristic, not a tokenizer guarantee.
  return MESSAGE_OVERHEAD_TOKENS + images * IMAGE_PART_TOKENS + Math.max(Math.ceil(chars / 4), Math.ceil(bytes / 2));
}
