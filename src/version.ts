import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const manifestUrl = new URL("../package.json", import.meta.url);

let metadata: unknown;
try {
  metadata = JSON.parse(readFileSync(manifestUrl, "utf8"));
} catch (err) {
  throw new Error(
    `Invalid installed package metadata: failed to load package manifest at ${fileURLToPath(manifestUrl)}.`,
    { cause: err }
  );
}

if (
  typeof metadata !== "object" || metadata === null
  || !("name" in metadata) || typeof metadata.name !== "string" || !metadata.name
  || !("version" in metadata) || typeof metadata.version !== "string" || !metadata.version
) {
  throw new Error("Invalid installed package metadata: nonempty name and version are required.");
}

/**
 * Protocol identity shared by the ACP initialize handshake and every MCP
 * client handshake. Derived from package.json so a release never advertises a
 * stale hardcoded version; the module throws at import time if the manifest is
 * unreadable or malformed — there is deliberately no fallback.
 */
export const AGENT_NAME = metadata.name;
export const AGENT_VERSION = metadata.version;
