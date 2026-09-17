import { spawn, type ChildProcess } from "node:child_process";

export type ProcessTerminationReason = "abort" | "timeout" | "shutdown";

/** A process group owned by one agent tool call. */
export interface ManagedProcess {
  /** Resolves after the owned process group has stopped or has been released. */
  cleanup: Promise<void>;
  /** Send TERM once, then escalate to KILL after a bounded grace period. */
  terminate(reason: ProcessTerminationReason): Promise<void>;
  /** Stop owning descendants after a shell completed normally. */
  releaseAfterNormalExit(): void;
}

const TERM_GRACE_MS = 250;
const KILL_SETTLE_MS = 500;
const PROBE_INTERVAL_MS = 20;

/**
 * Tracks command process groups for one ACP agent. A command remains owned
 * after its shell closes when cancellation has started, so shutdown can await
 * the SIGTERM -> SIGKILL sequence instead of losing it to process.exit().
 */
export class ProcessSupervisor {
  private readonly processes = new Set<TrackedProcess>();

  register(child: ChildProcess): ManagedProcess {
    const process = new TrackedProcess(child, () => this.processes.delete(process));
    this.processes.add(process);
    return process;
  }

  async terminateAll(): Promise<void> {
    // A termination can make a command loop advance far enough to register its
    // next child. Keep draining until the owned set is stable.
    while (this.processes.size > 0) {
      const current = [...this.processes];
      await Promise.allSettled(current.map((process) => process.terminate("shutdown")));
      if (current.every((process) => !this.processes.has(process))) return;
      // Processes that could not be proved dead remain owned for the caller to
      // inspect and force after its overall shutdown deadline.
      return;
    }
  }

  async forceTerminateAll(): Promise<void> {
    await Promise.allSettled([...this.processes].map((process) => process.forceTerminate()));
  }

  hasActiveProcesses(): boolean {
    for (const process of this.processes) {
      if (process.isActive()) return true;
    }
    return false;
  }
}

class TrackedProcess implements ManagedProcess {
  private released = false;
  private termination: Promise<void> | null = null;
  private resolveCleanup!: () => void;
  readonly cleanup = new Promise<void>((resolve) => {
    this.resolveCleanup = resolve;
  });

  constructor(
    private readonly child: ChildProcess,
    private readonly remove: () => void
  ) {}

  terminate(_reason: ProcessTerminationReason): Promise<void> {
    void _reason;
    if (this.released) return this.cleanup;
    if (!this.termination) this.termination = this.terminateWithEscalation(false);
    return this.termination;
  }

  async forceTerminate(): Promise<void> {
    if (this.released) return;
    if (this.termination) return this.termination;
    this.termination = this.terminateWithEscalation(true);
    return this.termination;
  }

  releaseAfterNormalExit(): void {
    if (this.released || this.termination) return;
    this.released = true;
    this.remove();
    this.resolveCleanup();
  }

  isActive(): boolean {
    return !this.released && isOwnedProcessAlive(this.child);
  }

  private async terminateWithEscalation(force: boolean): Promise<void> {
    if (!force) {
      await terminateOwnedProcess(this.child, false);
      await delay(TERM_GRACE_MS);
    }
    if (isOwnedProcessAlive(this.child)) await terminateOwnedProcess(this.child, true);
    const stopped = await waitForStopped(this.child, KILL_SETTLE_MS);
    if (stopped) {
      this.released = true;
      this.remove();
      this.resolveCleanup();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStopped(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isOwnedProcessAlive(child)) {
    if (Date.now() >= deadline) return false;
    await delay(PROBE_INTERVAL_MS);
  }
  return true;
}

function isOwnedProcessAlive(child: ChildProcess): boolean {
  if (!child.pid) return false;
  if (process.platform === "win32") {
    try {
      process.kill(child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function terminateOwnedProcess(child: ChildProcess, force: boolean): Promise<void> {
  if (!child.pid) return;
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  if (process.platform === "win32") {
    const killed = await taskkill(child.pid);
    if (killed) return;
  }
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child exited between the liveness probe and signal delivery.
    }
  }
}

function taskkill(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => settle(false));
    killer.once("close", (code) => settle(code === 0));
  });
}
