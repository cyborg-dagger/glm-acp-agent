import test from "node:test";
import assert from "node:assert/strict";
import { collectToolPages } from "../tools/mcp-pagination.js";

const noSignal = new AbortController().signal;

test("collectToolPages preserves opaque cursors and page order", async () => {
  const cursors: Array<string | undefined> = [];
  const tools = await collectToolPages({
    signal: noSignal,
    maxPages: 4,
    maxTools: 10,
    maxSchemaBytes: 10_000,
    requestPage: async (cursor) => {
      cursors.push(cursor);
      return cursor === undefined
        ? { tools: [{ name: "first" }], nextCursor: "opaque cursor / 1" }
        : { tools: [{ name: "second" }] };
    },
  });

  assert.deepEqual(cursors, [undefined, "opaque cursor / 1"]);
  assert.deepEqual(tools, [{ name: "first" }, { name: "second" }]);
});

test("collectToolPages rejects cursor cycles instead of returning a partial catalog", async () => {
  await assert.rejects(
    () => collectToolPages({
      signal: noSignal,
      maxPages: 10,
      maxTools: 10,
      maxSchemaBytes: 10_000,
      requestPage: async (cursor) => ({
        tools: [{ name: cursor ?? "first" }],
        nextCursor: cursor === undefined ? "cycle" : "cycle",
      }),
    }),
    /cursor cycle/i,
  );
});

test("collectToolPages rejects malformed cursors and each capacity limit", async () => {
  await assert.rejects(
    () => collectToolPages({
      signal: noSignal,
      maxPages: 2,
      maxTools: 10,
      maxSchemaBytes: 10_000,
      requestPage: async () => ({ tools: [], nextCursor: 42 as never }),
    }),
    /cursor.*string/i,
  );
  await assert.rejects(
    () => collectToolPages({
      signal: noSignal,
      maxPages: 1,
      maxTools: 10,
      maxSchemaBytes: 10_000,
      requestPage: async () => ({ tools: [{ name: "one" }], nextCursor: "more" }),
    }),
    /page limit/i,
  );
  await assert.rejects(
    () => collectToolPages({
      signal: noSignal,
      maxPages: 2,
      maxTools: 1,
      maxSchemaBytes: 10_000,
      requestPage: async () => ({ tools: [{ name: "one" }, { name: "two" }] }),
    }),
    /tool limit/i,
  );
  await assert.rejects(
    () => collectToolPages({
      signal: noSignal,
      maxPages: 2,
      maxTools: 10,
      maxSchemaBytes: 3,
      requestPage: async () => ({ tools: [{ name: "one" }] }),
    }),
    /schema.*limit/i,
  );
});
