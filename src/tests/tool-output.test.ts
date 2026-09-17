import test from "node:test";
import assert from "node:assert/strict";
import { boundToolResult } from "../tools/tool-output.js";

test("tool output fits an inclusive UTF-8 budget without splitting characters", () => {
  const result = boundToolResult("🙂".repeat(100_000), 262_144);
  assert.ok(Buffer.byteLength(result, "utf8") <= 262_144);
  assert.match(result, /bytes omitted/);
  assert.ok(!result.includes("\uFFFD"));
});

test("tool output returns the original string when it fits", () => {
  assert.equal(boundToolResult("hé", 128), "hé");
});

test("tool output keeps complete characters at both retained boundaries", () => {
  const result = boundToolResult("α".repeat(1_000) + "🙂".repeat(1_000), 128);
  assert.ok(!result.includes("\uFFFD"));
  assert.equal(Buffer.byteLength(result, "utf8") <= 128, true);
});
