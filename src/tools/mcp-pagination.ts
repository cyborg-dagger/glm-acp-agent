export interface ToolPage<T> {
  tools: T[];
  nextCursor?: string | null;
}

export const DEFAULT_MCP_MAX_PAGES = 100;
export const DEFAULT_MCP_MAX_TOOLS = 1_000;
export const DEFAULT_MCP_MAX_SCHEMA_BYTES = 4 * 1024 * 1024;

/** Reject a malformed page before adapters can turn it into an empty catalog. */
export function assertValidToolPage(result: unknown): asserts result is Record<string, unknown> & { tools: unknown[] } {
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      !("tools" in result) || !Array.isArray(result.tools)) {
    throw new Error("Malformed MCP tools/list result: tools must be an array.");
  }
  for (const tool of result.tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool) ||
        !("name" in tool) || typeof tool.name !== "string" || !tool.name.trim()) {
      throw new Error("Malformed MCP tools/list result: each tool needs a nonempty name.");
    }
  }
}

export interface CollectToolPagesOptions<T> {
  requestPage: (cursor: string | undefined, signal: AbortSignal) => Promise<ToolPage<T>>;
  signal: AbortSignal;
  maxPages: number;
  maxTools: number;
  maxSchemaBytes: number;
}

/**
 * Collects an MCP tools/list catalog without silently truncating a paginated
 * response. Cursors are opaque: they are only compared for cycle detection
 * and passed back to the server unchanged.
 */
export async function collectToolPages<T>(options: CollectToolPagesOptions<T>): Promise<T[]> {
  assertPositiveLimit("maxPages", options.maxPages);
  assertPositiveLimit("maxTools", options.maxTools);
  assertPositiveLimit("maxSchemaBytes", options.maxSchemaBytes);

  const tools: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let schemaBytes = 0;

  for (let pageNumber = 1; ; pageNumber += 1) {
    if (pageNumber > options.maxPages) {
      throw new Error(`MCP tools/list page limit exceeded (maxPages=${options.maxPages})`);
    }
    const page = await options.requestPage(cursor, options.signal);
    if (!page || typeof page !== "object" || !Array.isArray(page.tools)) {
      throw new Error("MCP tools/list returned a malformed page: tools must be an array");
    }

    for (const tool of page.tools) {
      tools.push(tool);
      if (tools.length > options.maxTools) {
        throw new Error(`MCP tools/list tool limit exceeded (maxTools=${options.maxTools})`);
      }
      const serialized = JSON.stringify(tool);
      schemaBytes += Buffer.byteLength(serialized ?? "", "utf8");
      if (schemaBytes > options.maxSchemaBytes) {
        throw new Error(`MCP tools/list schema limit exceeded (maxSchemaBytes=${options.maxSchemaBytes})`);
      }
    }

    const nextCursor = page.nextCursor;
    if (nextCursor === undefined || nextCursor === null) return tools;
    if (typeof nextCursor !== "string") {
      throw new Error("MCP tools/list returned a malformed cursor: nextCursor must be a string or null");
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error("MCP tools/list cursor cycle detected.");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

function assertPositiveLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`MCP tools/list ${name} must be a positive integer`);
  }
}
