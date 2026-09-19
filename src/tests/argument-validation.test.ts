import test from "node:test";
import assert from "node:assert/strict";
import { validateToolArguments } from "../tools/argument-validation.js";

test("built-in tool arguments accept only JSON object roots", () => {
  for (const rawArguments of ["null", "[]", "\"path\"", "1", "true", "{"]) {
    const result = validateToolArguments("read_file", rawArguments);
    assert.equal(result.ok, false, rawArguments);
    if (!result.ok) assert.match(result.message, /JSON|object/i);
  }
});

test("built-in schemas reject missing required properties and wrong optional types", () => {
  const cases = [
    ["read_file", "{}", /path.*required/i],
    ["read_file", '{"path":"file.txt","offset":"2"}', /offset.*number/i],
    ["web_search", '{"query":"needle","count":1.5}', /count.*integer/i],
    ["web_search", '{"query":"needle","count":51}', /count.*(maximum|at most)/i],
    ["web_reader", '{"url":"https://example.test","return_format":"html"}', /return_format.*one of/i],
    ["todowrite", '{"todos":[{"content":"Ship it"}]}', /status.*required/i],
    ["todowrite", '{"todos":[{"content":"Ship it","status":"broken"}]}', /status.*one of/i],
  ] as const;

  for (const [toolName, rawArguments, expected] of cases) {
    const result = validateToolArguments(toolName, rawArguments);
    assert.equal(result.ok, false, `${toolName}: ${rawArguments}`);
    if (!result.ok) assert.match(result.message, expected);
  }
});

test("built-in validation keeps compatible unknown fields and explicit empty write text", () => {
  const result = validateToolArguments(
    "write_file",
    '{"path":"out.txt","content":"","future_option":{"keep":true}}'
  );
  assert.deepEqual(result, {
    ok: true,
    value: { path: "out.txt", content: "", future_option: { keep: true } },
  });
});

test("write and edit constraints reject absent, null, or empty destructive inputs", () => {
  const cases = [
    ["write_file", '{"path":"out.txt"}', /content.*required/i],
    ["write_file", '{"path":"out.txt","content":null}', /content.*string/i],
    ["edit_file", '{"path":"out.txt","old_text":"x"}', /new_text.*required/i],
    ["edit_file", '{"path":"out.txt","old_text":"x","new_text":null}', /new_text.*string/i],
    ["edit_file", '{"path":"out.txt","old_text":"","new_text":"x"}', /old_text.*non-empty/i],
    ["run_command", '{"command":"   "}', /command.*non-empty/i],
  ] as const;

  for (const [toolName, rawArguments, expected] of cases) {
    const result = validateToolArguments(toolName, rawArguments);
    assert.equal(result.ok, false, `${toolName}: ${rawArguments}`);
    if (!result.ok) assert.match(result.message, expected);
  }
});

test("edit_file accepts non-empty whitespace-only exact-match targets", () => {
  const result = validateToolArguments(
    "edit_file",
    '{"path":"out.txt","old_text":"\\n\\n","new_text":"replacement"}'
  );

  assert.deepEqual(result, {
    ok: true,
    value: { path: "out.txt", old_text: "\n\n", new_text: "replacement" },
  });
});
