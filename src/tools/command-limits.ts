export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES = 65_536;

export interface CommandLimits {
  timeoutMs: number;
  outputLimitBytes: number;
}

type Environment = Record<string, string | undefined>;
type Warn = (message: string) => void;

const MAX_COMMAND_TIMEOUT_MS = 2_147_483_647;

function readPositiveInteger(
  env: Environment,
  name: string,
  fallback: number,
  max: number,
  warn: Warn
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    warn(`glm-acp-agent: ignoring invalid ${name} value "${raw}"; using ${fallback}`);
    return fallback;
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    warn(`glm-acp-agent: ignoring invalid ${name} value "${raw}"; using ${fallback}`);
    return fallback;
  }
  return value;
}

export function readCommandLimits(env: Environment = process.env, warn: Warn = (message) => process.stderr.write(`${message}\n`)): CommandLimits {
  return {
    timeoutMs: readPositiveInteger(
      env,
      "ACP_GLM_COMMAND_TIMEOUT_MS",
      DEFAULT_COMMAND_TIMEOUT_MS,
      MAX_COMMAND_TIMEOUT_MS,
      warn
    ),
    outputLimitBytes: readPositiveInteger(
      env,
      "ACP_GLM_COMMAND_OUTPUT_LIMIT_BYTES",
      DEFAULT_COMMAND_OUTPUT_LIMIT_BYTES,
      Number.MAX_SAFE_INTEGER,
      warn
    ),
  };
}
