import test from "node:test";
import assert from "node:assert/strict";
import { appendCompactionNote, compactToBudget } from "../protocol/context-budget.js";
import type { GlmMessage } from "../llm/glm-client.js";

const budget = { contextWindow: 20_000, maxOutputTokens: 2_000, toolSchemaTokens: 200, safetyTokens: 4_096 };

test("compaction removes whole completed exchanges and keeps reasoning intact", () => {
  const messages: GlmMessage[] = [{ role: "system", content: "rules" }];
  for (let i = 0; i < 4; i++) {
    messages.push({ role: "user", content: `request ${i} ${"中".repeat(5000)}` });
    messages.push({ role: "assistant", content: "calling", reasoning_content: `reasoning ${i}`, tool_calls: [{ id: String(i), type: "function", function: { name: "read_file", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: String(i), content: "result".repeat(5000) });
  }
  const compacted = compactToBudget(messages, budget, true);
  assert.ok(compacted.changed);
  assert.ok(compacted.removedExchanges > 0);
  assert.ok(compacted.messages.some(message => message.role === "assistant" && message.reasoning_content === "reasoning 3"));
  assert.ok(!compacted.messages.some(message => message.role === "tool" && message.tool_call_id === "0"));
});

test("compaction note preserves string user content and identifies omissions", () => {
  const source: GlmMessage = { role: "user", content: "original user request" };
  const noted = appendCompactionNote(source, 2, 1);
  assert.match(String(noted.content), /original user request/);
  assert.match(String(noted.content), /omitted 2 completed exchanges/);
});
