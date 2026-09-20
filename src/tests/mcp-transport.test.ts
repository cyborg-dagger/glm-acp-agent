import test from "node:test";
import assert from "node:assert/strict";
import { createDeadline, readBoundedBody, readDiagnosticBody, readRpcResponse } from "../tools/mcp-transport.js";
import type { ResourceLimits } from "../tools/resource-limits.js";

const noSignal = new AbortController().signal;

function limits(overrides: Partial<ResourceLimits> = {}): ResourceLimits {
  return {
    toolResultBytes: 262_144,
    fileReadBytes: 1024,
    listEntries: 100,
    listBytes: 1024,
    fsConcurrency: 16,
    mcpResponseBytes: 1_000,
    mcpEventBytes: 500,
    mcpFrameBytes: 1_000,
    ...overrides,
  };
}

interface TrackedStream {
  response: Response;
  cancelled: () => boolean;
  chunksEnqueued: () => number;
}

/** A Response whose body enqueues the given chunks; records cancellation and production count. */
function trackedResponse(
  chunks: Array<string | Uint8Array>,
  options: { contentType?: string; contentLength?: string; neverClose?: boolean; closeAfterChunks?: boolean } = {},
): TrackedStream {
  let cancelled = false;
  let enqueued = 0;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index++];
        controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
        enqueued += 1;
      } else if (options.neverClose) {
        await new Promise(() => undefined);
      } else {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const headers: Record<string, string> = {};
  if (options.contentType !== undefined) headers["content-type"] = options.contentType;
  if (options.contentLength !== undefined) headers["content-length"] = options.contentLength;
  return {
    response: new Response(stream, { status: 200, headers }),
    cancelled: () => cancelled,
    chunksEnqueued: () => enqueued,
  };
}

function sseEvent(data: string, event?: string): string {
  const lines = event ? [`event: ${event}`] : [];
  return `${lines.join("\n")}\ndata: ${data}\n\n`;
}

test("createDeadline aborts with a timeout reason and dispose clears the timer", async () => {
  const deadline = createDeadline(undefined, 15);
  await new Promise((resolve) => {
    deadline.signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
  assert.ok(deadline.signal.aborted);
  assert.match(String((deadline.signal.reason as Error)?.message ?? ""), /timed out after 15ms/i);

  const disposed = createDeadline(undefined, 10);
  disposed.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(disposed.signal.aborted, false);
});

test("createDeadline rejects immediately when the parent is already aborted and keeps the parent reason", () => {
  const parent = new AbortController();
  const callerCancel = new Error("MCP call cancelled by the client");
  parent.abort(callerCancel);
  const deadline = createDeadline(parent.signal, 60_000);
  assert.ok(deadline.signal.aborted);
  assert.equal(deadline.signal.reason, callerCancel);
  deadline.dispose();
});

test("createDeadline propagates a later parent abort distinctly from timeout", async () => {
  const parent = new AbortController();
  const deadline = createDeadline(parent.signal, 60_000);
  const callerCancel = new Error("cancelled");
  parent.abort(callerCancel);
  assert.ok(deadline.signal.aborted);
  assert.equal(deadline.signal.reason, callerCancel);
  deadline.dispose();
});

test("readBoundedBody returns the concatenated bytes of a complete body", async () => {
  const tracked = trackedResponse(["{\"id\":1,", " \"result\":{}}"], { contentType: "application/json" });
  const bytes = await readBoundedBody(tracked.response, 1_000, noSignal);
  assert.equal(new TextDecoder().decode(bytes), "{\"id\":1, \"result\":{}}");
  assert.equal(tracked.cancelled(), false);
});

test("readBoundedBody rejects on the first chunk crossing the byte cap and cancels the stream", async () => {
  const tracked = trackedResponse(["a".repeat(600), "b".repeat(600), "c".repeat(600)], { contentType: "application/json" });
  await assert.rejects(
    () => readBoundedBody(tracked.response, 1_000, noSignal),
    /exceeded the 1000-byte limit after 1200 bytes/i,
  );
});

test("readBoundedBody rejects early from Content-Length without consuming the body", async () => {
  const tracked = trackedResponse(["a".repeat(50)], { contentType: "application/json", contentLength: "5000" });
  await assert.rejects(
    () => readBoundedBody(tracked.response, 1_000, noSignal),
    /exceed|limit|too large/i,
  );
  assert.equal(tracked.chunksEnqueued(), 0);
  assert.ok(tracked.cancelled());
});

test("readBoundedBody rejects through an aborted signal and cancels the stream", async () => {
  const tracked = trackedResponse(["partial"], { contentType: "application/json", neverClose: true });
  const controller = new AbortController();
  const pending = readBoundedBody(tracked.response, 1_000, controller.signal);
  controller.abort(new Error("MCP call cancelled by the client"));
  await assert.rejects(() => pending, /cancelled by the client/i);
  assert.ok(tracked.cancelled());
});

test("readBoundedBody rejects with the abort reason even when stream cancellation never settles", { timeout: 5_000 }, async () => {
  let cancelCalled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(200)));
    },
    cancel() {
      cancelCalled = true;
      return new Promise<never>(() => undefined);
    },
  });
  const response = new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  const caller = new AbortController();
  const pending = readBoundedBody(response, 1_000, caller.signal);
  caller.abort(new Error("MCP call cancelled by the client"));
  await assert.rejects(() => pending, /cancelled by the client/i);
  assert.ok(cancelCalled, "cancellation must still be initiated");
});

test("readBoundedBody rejects early on Content-Length even when cancellation never settles", { timeout: 5_000 }, async () => {
  const stream = new ReadableStream<Uint8Array>({
    async pull() {
      await new Promise(() => undefined);
    },
    cancel() {
      return new Promise<never>(() => undefined);
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { "content-type": "application/json", "content-length": "5000" },
  });
  await assert.rejects(() => readBoundedBody(response, 1_000, noSignal), /exceeded the 1000-byte limit/i);
});

test("readRpcResponse parses a JSON response with a matching id", async () => {
  const tracked = trackedResponse([JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: [] } })], {
    contentType: "application/json",
  });
  const envelope = await readRpcResponse(tracked.response, 7, limits(), noSignal);
  assert.equal(envelope.id, 7);
  assert.deepEqual(envelope.result, { tools: [] });
  assert.equal(envelope.error, undefined);
});

test("readRpcResponse returns the error envelope for a JSON-RPC error", async () => {
  const tracked = trackedResponse([JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32000, message: "boom" } })], {
    contentType: "application/json",
  });
  const envelope = await readRpcResponse(tracked.response, 3, limits(), noSignal);
  assert.deepEqual(envelope.error, { code: -32000, message: "boom" });
});

test("readRpcResponse rejects a JSON response whose id does not match the request", async () => {
  const tracked = trackedResponse([JSON.stringify({ jsonrpc: "2.0", id: 42, result: {} })], {
    contentType: "application/json",
  });
  await assert.rejects(() => readRpcResponse(tracked.response, 7, limits(), noSignal), /id.*42|mismatch|matching/i);
});

test("readRpcResponse rejects oversized streamed JSON before full consumption", async () => {
  const filler = `{"id":7,"result":"${"x".repeat(400)}"}`;
  const tracked = trackedResponse([filler.slice(0, 400), filler.slice(400), filler, filler, filler], {
    contentType: "application/json",
  });
  // Five chunks are ~430 bytes each; a cap of 1000 must reject after the third
  // read (≈933 + 430 bytes), proving rejection before the body is fully consumed.
  await assert.rejects(
    () => readRpcResponse(tracked.response, 7, limits({ mcpResponseBytes: 1_000 }), noSignal),
    /exceeded the 1000-byte limit after \d{4} bytes/i,
  );
});

test("readRpcResponse ignores SSE notifications, comments and multiline data before the matching result", async () => {
  const data = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } }).slice(0, 10);
  const rest = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } }).slice(10);
  const tracked = trackedResponse(
    [
      ": keep-alive comment\r\n\r\n",
      `event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\r\n\r\n`,
      `data: ${data}\r\ndata: ${rest}\r\n\r\n`,
    ],
    { contentType: "text/event-stream" },
  );
  const envelope = await readRpcResponse(tracked.response, 7, limits(), noSignal);
  assert.deepEqual(envelope.result, { ok: true });
});

test("readRpcResponse skips a wrong response id and accepts the matching one", async () => {
  const tracked = trackedResponse(
    [
      sseEvent(JSON.stringify({ jsonrpc: "2.0", id: 41, result: { wrong: true } })),
      sseEvent(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { right: true } })),
      sseEvent(JSON.stringify({ jsonrpc: "2.0", id: 9, result: { later: true } })),
    ],
    { contentType: "text/event-stream", neverClose: true },
  );
  const envelope = await readRpcResponse(tracked.response, 7, limits(), noSignal);
  assert.deepEqual(envelope.result, { right: true });
  assert.ok(tracked.cancelled(), "consumption must stop after the matching result");
});

test("readRpcResponse fails when an SSE stream ends without a matching response", async () => {
  const tracked = trackedResponse(
    [sseEvent(JSON.stringify({ jsonrpc: "2.0", id: 41, result: {} }))],
    { contentType: "text/event-stream" },
  );
  await assert.rejects(() => readRpcResponse(tracked.response, 7, limits(), noSignal), /matching response|did not contain|response id/i);
});

test("readRpcResponse rejects a single SSE event that exceeds the event cap without truncating it", async () => {
  const huge = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { blob: "y".repeat(2_000) } });
  const tracked = trackedResponse([sseEvent(huge)], { contentType: "text/event-stream" });
  await assert.rejects(
    () => readRpcResponse(tracked.response, 7, limits({ mcpEventBytes: 500 }), noSignal),
    /exceeded the 500-byte event limit/i,
  );
});

test("readRpcResponse rejects SSE events whose running size crosses the event cap before any terminator", async () => {
  // 40 short data lines (27 bytes each) with no blank-line terminator: the
  // logical event grows to 800 bytes against a 500-byte event cap, while the
  // stream total (1080 bytes against 1000) alone would not stop it in time.
  const tracked = trackedResponse(
    Array.from({ length: 40 }, () => `data: ${"x".repeat(20)}\n`),
    { contentType: "text/event-stream", neverClose: true },
  );
  const deadline = createDeadline(undefined, 2_000);
  try {
    await assert.rejects(
      () => readRpcResponse(tracked.response, 7, limits({ mcpEventBytes: 500 }), deadline.signal),
      /exceeded the 500-byte event limit/i,
    );
  } finally {
    deadline.dispose();
  }
});

test("readRpcResponse bounds the total bytes consumed from an endless SSE stream", async () => {
  const filler = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { n: "z".repeat(80) } });
  const tracked = trackedResponse(
    Array.from({ length: 40 }, () => sseEvent(filler)),
    { contentType: "text/event-stream", neverClose: true },
  );
  await assert.rejects(
    () => readRpcResponse(tracked.response, 7, limits({ mcpResponseBytes: 1_000 }), noSignal),
    /exceed|limit|too large/i,
  );
  assert.ok(tracked.cancelled());
});

test("readRpcResponse rejects a matching SSE response whose chunk exceeds the total byte cap", async () => {
  // One ~360-byte SSE chunk holding the matching response against a 100-byte
  // stream cap: acceptance must not bypass the raw byte total.
  const data = JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true, blob: "z".repeat(300) } });
  const tracked = trackedResponse([sseEvent(data)], { contentType: "text/event-stream" });
  await assert.rejects(
    () => readRpcResponse(tracked.response, 7, limits({ mcpResponseBytes: 100 }), noSignal),
    /exceeded the 100-byte limit/i,
  );
});

test("readRpcResponse times out on a stalled body and cancels the stream (injected budget)", async () => {
  const tracked = trackedResponse(["data: {\"id\":7,\"res"], { contentType: "text/event-stream", neverClose: true });
  const deadline = createDeadline(undefined, 20);
  try {
    await assert.rejects(
      readRpcResponse(tracked.response, 7, limits(), deadline.signal),
      /timeout|timed out|abort/i,
    );
  } finally {
    deadline.dispose();
  }
  assert.ok(tracked.cancelled(), "the stalled stream must be cancelled, not left open");
});

test("readRpcResponse surfaces caller cancellation distinctly from timeout", async () => {
  const tracked = trackedResponse(["data: {\"id\":7,\"res"], { contentType: "text/event-stream", neverClose: true });
  const caller = new AbortController();
  const pending = readRpcResponse(tracked.response, 7, limits(), caller.signal);
  caller.abort(new Error("MCP call cancelled by the client"));
  await assert.rejects(() => pending, /cancelled by the client/i);
  assert.ok(tracked.cancelled());
});

test("readRpcResponse returns the matching SSE envelope even when stream cancellation never settles", { timeout: 5_000 }, async () => {
  let cancelCalled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseEvent(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { ok: true } }))));
    },
    cancel() {
      cancelCalled = true;
      return new Promise<never>(() => undefined);
    },
  });
  const response = new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  const envelope = await readRpcResponse(response, 7, limits(), noSignal);
  assert.deepEqual(envelope.result, { ok: true });
  assert.ok(cancelCalled, "cancellation must still be initiated");
});

test("readRpcResponse still surfaces a timeout when the SSE stream's cancellation never settles", { timeout: 5_000 }, async () => {
  const stream = new ReadableStream<Uint8Array>({
    async pull() {
      await new Promise(() => undefined);
    },
    cancel() {
      return new Promise<never>(() => undefined);
    },
  });
  const response = new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  const deadline = createDeadline(undefined, 20);
  try {
    await assert.rejects(() => readRpcResponse(response, 7, limits(), deadline.signal), /timed out after 20ms/i);
  } finally {
    deadline.dispose();
  }
});

test("readDiagnosticBody rethrows caller cancellation and timeout instead of an empty diagnostic", async () => {
  const cancelled = trackedResponse(["partial"], { contentType: "text/plain", neverClose: true });
  const caller = new AbortController();
  const pending = readDiagnosticBody(cancelled.response, limits(), caller.signal);
  caller.abort(new Error("MCP call cancelled by the client"));
  await assert.rejects(() => pending, /cancelled by the client/i);

  const stalled = trackedResponse(["partial"], { contentType: "text/plain", neverClose: true });
  const deadline = createDeadline(undefined, 20);
  try {
    await assert.rejects(
      () => readDiagnosticBody(stalled.response, limits(), deadline.signal),
      /timed out after 20ms/i,
    );
  } finally {
    deadline.dispose();
  }
});

test("readDiagnosticBody rethrows body-limit errors and still swallows ordinary body failures", async () => {
  const oversized = trackedResponse(["y".repeat(50)], { contentType: "text/plain", contentLength: "5000" });
  await assert.rejects(
    () => readDiagnosticBody(oversized.response, limits({ mcpResponseBytes: 1_000 }), noSignal),
    /exceeded the 1000-byte limit/i,
  );

  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("socket reset"));
    },
  });
  assert.equal(await readDiagnosticBody(new Response(broken, { status: 500 }), limits(), noSignal), "");
});
