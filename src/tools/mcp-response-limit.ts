import { takeUtf8Prefix } from "./tool-output.js";

/** Maximum bytes accepted from one MCP HTTP response or stdio JSON-RPC frame. */
export const MCP_RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Oversize gate for buffered stdio frames. UTF-8 byte length is at least the
 * character count, so a buffer whose character count alone is at or under the
 * limit skips the O(n) byte-length scan entirely (the fast path that keeps
 * chunk-by-chunk checks off the quadratic path). An oversized multi-byte frame
 * is still killed once its character count alone exceeds the limit.
 */
export function exceedsMcpResponseLimit(text: string): boolean {
  return text.length > MCP_RESPONSE_LIMIT_BYTES
    && Buffer.byteLength(text, "utf8") > MCP_RESPONSE_LIMIT_BYTES;
}

/** Cap a response body interpolated into an Error message (~2 KB, like STDERR_MESSAGE_LIMIT). */
export function clampMcpHttpErrorBody(text: string, maxBytes = 2_000): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${takeUtf8Prefix(text, maxBytes)}…`;
}

/** Read a response without letting a peer force an unbounded text() allocation. */
export async function readMcpResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MCP_RESPONSE_LIMIT_BYTES) {
        throw new Error(`MCP response exceeds ${MCP_RESPONSE_LIMIT_BYTES}-byte limit`);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }
}
