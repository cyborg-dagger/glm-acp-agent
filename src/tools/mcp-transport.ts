import { Buffer } from "node:buffer";
import type { ResourceLimits } from "./resource-limits.js";

/**
 * Bounded, cancellable primitives shared by every MCP transport (streamable
 * HTTP with JSON or SSE bodies, and newline-delimited stdio frames).
 *
 * Time and memory are bounded together: a {@link Deadline} covers the fetch
 * *and* the consumption of its body, and every read path counts bytes before
 * decoding so an oversized payload is rejected before it can allocate.
 */

export interface Deadline {
  signal: AbortSignal;
  dispose(): void;
}

/**
 * Combines an optional caller signal with a timeout into one signal.
 *
 * The timeout aborts with an `Error` whose message says `timed out after …ms`;
 * a caller abort propagates the caller's own abort reason, so timeout stays
 * distinguishable from cancellation. `dispose` clears the timer and detaches
 * from the parent; after it runs the signal no longer aborts on its own.
 */
export function createDeadline(parent: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController();
  const propagateParent = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => {
    controller.abort(new Error(`timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  // Never keep the process alive just to fire an abandoned deadline.
  timer.unref?.();
  if (parent) {
    if (parent.aborted) propagateParent();
    else parent.addEventListener("abort", propagateParent, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", propagateParent);
    },
  };
}

function abortError(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error("aborted");
}

/** Thrown when a response body crosses its configured byte budget. */
class BodyLimitError extends Error {}

/**
 * Initiates stream cancellation without awaiting it: a stream whose `cancel()`
 * never settles must not hold the surrounding result or error hostage. The
 * underlying source's cancel callback still runs synchronously; only the
 * settlement of the returned promise is ignored, and rejections are swallowed.
 */
function cancelDetached(cancel: Promise<unknown> | undefined): void {
  void cancel?.catch(() => undefined);
}

/** A single `reader.read()` raced against the signal, so stalled bodies are cancellable. */
async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw abortError(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      // Defer by a microtask: a body that errors itself on this same abort
      // tick (real fetch bodies, spec-compliant fixtures) wins the race with
      // its more precise error; only a silent body falls back to the signal.
      queueMicrotask(() => reject(abortError(signal)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Reads a response body incrementally, rejecting on the first chunk that
 * crosses `maxBytes`. `Content-Length` allows an early rejection but is never
 * trusted as the only bound. On any failure the reader is cancelled so the
 * body (and its underlying fetch) cannot keep allocating.
 */
export async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    cancelDetached(response.body?.cancel());
    throw new BodyLimitError(`MCP response body exceeded the ${maxBytes}-byte limit (Content-Length: ${declared})`);
  }
  const body = response.body;
  if (!body) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) break;
      // Count bytes before any decoding: the cap is on wire bytes.
      received += value.byteLength;
      if (received > maxBytes) {
        throw new BodyLimitError(`MCP response body exceeded the ${maxBytes}-byte limit after ${received} bytes`);
      }
      chunks.push(value);
    }
  } catch (err) {
    cancelDetached(reader.cancel(err));
    throw err;
  }
  const total = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    total.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return total;
}

export interface RpcResultEnvelope {
  id: string | number;
  result?: unknown;
  error?: { code?: string | number; message?: string; [key: string]: unknown };
}

/**
 * Reads one JSON-RPC response (`application/json` or `text/event-stream`)
 * under byte and time budgets. SSE notifications and comments are ignored;
 * only a response whose id matches `requestId` is accepted, and consumption
 * stops at that response even when the server keeps the stream open.
 */
export async function readRpcResponse(
  response: Response,
  requestId: string | number,
  limits: ResourceLimits,
  signal: AbortSignal,
): Promise<RpcResultEnvelope> {
  const contentType = (response.headers.get("Content-Type") ?? "").toLowerCase();
  if (contentType.includes("text/event-stream")) {
    return readSseRpcResponse(response, requestId, limits, signal);
  }
  const bytes = await readBoundedBody(response, limits.mcpResponseBytes, signal);
  const text = new TextDecoder("utf-8").decode(bytes);
  return parseJsonRpcEnvelope(text, requestId);
}

function parseJsonRpcEnvelope(text: string, requestId: string | number): RpcResultEnvelope {
  if (!text.trim()) throw new Error("MCP response was empty.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error("MCP response was not valid JSON", { cause: err });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("MCP response was not a JSON-RPC object.");
  }
  const record = parsed as { id?: unknown; result?: unknown; error?: RpcResultEnvelope["error"] };
  if (record.id !== requestId) {
    throw new Error(`MCP response id ${String(record.id)} does not match the request id ${String(requestId)}.`);
  }
  return { id: requestId, result: record.result, error: record.error };
}

/** Incremental SSE scanner: emits completed event payloads, bounds every line and event. */
class SseScanner {
  private buffer = "";
  private dataLines: string[] = [];
  /** Running UTF-8 byte count of the current event's data payload. */
  private eventBytes = 0;

  constructor(private readonly maxEventBytes: number) {}

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const event = this.acceptLine(line);
      if (event !== undefined) events.push(event);
    }
    if (Buffer.byteLength(this.buffer) > this.maxEventBytes) {
      throw new Error(`MCP SSE line exceeded the ${this.maxEventBytes}-byte event limit`);
    }
    return events;
  }

  flush(): string[] {
    const events: string[] = [];
    let line = this.buffer;
    this.buffer = "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    for (const boundary of [line, ""]) {
      const event = this.acceptLine(boundary);
      if (event !== undefined) events.push(event);
    }
    return events;
  }

  private acceptLine(line: string): string | undefined {
    if (Buffer.byteLength(line) > this.maxEventBytes) {
      throw new Error(`MCP SSE line exceeded the ${this.maxEventBytes}-byte event limit`);
    }
    if (line === "") {
      if (this.dataLines.length === 0) return undefined;
      const data = this.dataLines.join("\n");
      this.dataLines = [];
      this.eventBytes = 0;
      return data;
    }
    if (line.startsWith(":")) return undefined;
    if (line.startsWith("data:")) {
      let value = line.slice("data:".length);
      if (value.startsWith(" ")) value = value.slice(1);
      // Count as the event grows, not only at the terminator: a peer that
      // never sends a blank line must not grow one event without bound.
      this.eventBytes += Buffer.byteLength(value) + (this.dataLines.length > 0 ? 1 : 0);
      if (this.eventBytes > this.maxEventBytes) {
        throw new Error(`MCP SSE event exceeded the ${this.maxEventBytes}-byte event limit`);
      }
      this.dataLines.push(value);
    }
    // `event:`, `id:` and `retry:` fields are ignored and never accumulated.
    return undefined;
  }
}

/** Diagnostics are for humans, not protocol data: keep them small. */
export const DIAGNOSTIC_TEXT_LIMIT = 2_000;

/**
 * Reads an error body under the same byte budget as protocol bodies and
 * truncates it to a small diagnostic string, so a hostile or broken server
 * cannot allocate an unbounded error message.
 */
export async function readDiagnosticBody(
  response: Response,
  limits: ResourceLimits,
  signal: AbortSignal,
): Promise<string> {
  try {
    const bytes = await readBoundedBody(response, limits.mcpResponseBytes, signal);
    let text = new TextDecoder("utf-8").decode(bytes);
    if (text.length > DIAGNOSTIC_TEXT_LIMIT) {
      text = `${text.slice(0, DIAGNOSTIC_TEXT_LIMIT)}… [truncated, ${text.length} chars total]`;
    }
    return text;
  } catch (err) {
    // Diagnostics are best-effort: ordinary body failures degrade to empty
    // text. But the caller's cancellation/timeout and byte-limit violations
    // must surface, not be replaced by a generic HTTP-status error.
    if (err instanceof BodyLimitError) throw err;
    if (signal.aborted) throw abortError(signal);
    return "";
  }
}

async function readSseRpcResponse(
  response: Response,
  requestId: string | number,
  limits: ResourceLimits,
  signal: AbortSignal,
): Promise<RpcResultEnvelope> {
  const body = response.body;
  if (!body) throw new Error("MCP SSE response had no body.");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const scanner = new SseScanner(limits.mcpEventBytes);
  let received = 0;

  const accept = (data: string): RpcResultEnvelope | undefined => {
    if (!data || data === "[DONE]") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      throw new Error("MCP SSE event was not valid JSON", { cause: err });
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as {
      id?: unknown;
      method?: unknown;
      result?: unknown;
      error?: RpcResultEnvelope["error"];
    };
    // Notifications (requests without an id the server expects us to answer) are
    // bounded noise: ignore them and keep waiting for the matching response.
    if (typeof record.method === "string" && record.result === undefined && record.error === undefined) {
      return undefined;
    }
    if (record.result === undefined && record.error === undefined) return undefined;
    if (record.id !== requestId) return undefined;
    return { id: requestId, result: record.result, error: record.error };
  };

  try {
    for (;;) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) break;
      // Enforce the raw byte total before decoding: only the remaining
      // response budget is decoded, so an oversized chunk is never expanded
      // in full. The scanner still sees that bounded prefix, so a single
      // over-limit event keeps being reported as such even when its chunk
      // also crosses the stream total.
      const budgetBefore = limits.mcpResponseBytes - received;
      received += value.byteLength;
      const decoded = value.byteLength <= budgetBefore
        ? decoder.decode(value, { stream: true })
        : decoder.decode(value.subarray(0, budgetBefore), { stream: true });
      const events = scanner.feed(decoded);
      if (received > limits.mcpResponseBytes) {
        throw new Error(`MCP SSE stream exceeded the ${limits.mcpResponseBytes}-byte limit after ${received} bytes`);
      }
      for (const data of events) {
        const envelope = accept(data);
        if (envelope) {
          // A server keeping the stream open must not hold the tool: stop consuming.
          cancelDetached(reader.cancel());
          return envelope;
        }
      }
    }
    for (const data of scanner.flush()) {
      const envelope = accept(data);
      if (envelope) return envelope;
    }
    throw new Error(`MCP SSE stream ended without a matching response for request id ${String(requestId)}.`);
  } catch (err) {
    cancelDetached(reader.cancel(err));
    throw err;
  }
}
